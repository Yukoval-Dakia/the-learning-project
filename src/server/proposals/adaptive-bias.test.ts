// P5.4-L2 / YUK-174 — DB-partition coverage for getProposalFeedbackDigest:
// per-(kind, relation) resolve from cooldown_key, symmetric-relation coalescing,
// net-negative dismiss-reason gating, edge-only rubric gates from the
// rubric_rejected bucket, and the cold-start empty list. Imports tests/helpers/db
// → DB partition (NOT in fastTestInclude; the pure decision helpers are covered
// by adaptive-bias.unit.test.ts).

import type { AiProposalPayloadInputT } from '@/core/schema/proposal';
import { PROPOSAL_FEEDBACK_BUDGET } from '@/server/ai/tools/budgets';
import { recordProposalDecisionSignal } from '@/server/proposals/signals';
import { writeAiProposal } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getProposalFeedbackDigest } from './adaptive-bias';

const BUDGET = PROPOSAL_FEEDBACK_BUDGET;

function edgeProposal(
  fromId: string,
  toId: string,
  relation: string,
  cooldownKey: string,
): AiProposalPayloadInputT {
  return {
    kind: 'knowledge_edge',
    target: { subject_kind: 'knowledge_edge', subject_id: null },
    reason_md: `attempt e_x judge cause concept on ${fromId}/${toId}`,
    evidence_refs: [],
    proposed_change: {
      from_knowledge_id: fromId,
      to_knowledge_id: toId,
      relation_type: relation,
      weight: 1,
    },
    cooldown_key: cooldownKey,
  };
}

describe('getProposalFeedbackDigest', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns an empty array on cold start (no proposal_signals rows)', async () => {
    expect(await getProposalFeedbackDigest(testDb(), BUDGET)).toEqual([]);
  });

  it('splits knowledge_edge into separate cells per relation (derived from cooldown_key)', async () => {
    const db = testDb();
    // prerequisite edge: 1 accept / 3 dismiss → net-negative, rate 0.25.
    await recordProposalDecisionSignal(
      db,
      {
        id: 'p1',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:a|b|prerequisite' },
      },
      'accept',
    );
    for (let i = 0; i < 3; i++) {
      await recordProposalDecisionSignal(
        db,
        {
          id: 'p1',
          kind: 'knowledge_edge',
          payload: { cooldown_key: 'knowledge_edge:a|b|prerequisite' },
        },
        'dismiss',
        'order not evidenced',
      );
    }
    // related_to edge: 3 accept / 1 dismiss → net-positive, rate 0.75.
    for (let i = 0; i < 3; i++) {
      await recordProposalDecisionSignal(
        db,
        {
          id: 'p2',
          kind: 'knowledge_edge',
          payload: { cooldown_key: 'knowledge_edge:c|d|related_to' },
        },
        'accept',
      );
    }
    await recordProposalDecisionSignal(
      db,
      {
        id: 'p2',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:c|d|related_to' },
      },
      'dismiss',
      'dumping ground',
    );

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const prereq = digest.find((c) => c.kind === 'knowledge_edge' && c.relation === 'prerequisite');
    const related = digest.find((c) => c.kind === 'knowledge_edge' && c.relation === 'related_to');
    expect(prereq).toMatchObject({
      accept_count: 1,
      dismiss_count: 3,
      total: 4,
      acceptance_rate: 0.25,
    });
    expect(related).toMatchObject({
      accept_count: 3,
      dismiss_count: 1,
      total: 4,
      acceptance_rate: 0.75,
    });
  });

  it('rolls a non-edge kind into a single relation:null cell (matches per-kind T-AR)', async () => {
    const db = testDb();
    await recordProposalDecisionSignal(
      db,
      { id: 'c1', kind: 'completion', payload: { cooldown_key: 'completion:li1' } },
      'accept',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'c2', kind: 'completion', payload: { cooldown_key: 'completion:li2' } },
      'dismiss',
      'too early',
    );

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const completion = digest.filter((c) => c.kind === 'completion');
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      kind: 'completion',
      relation: null,
      accept_count: 1,
      dismiss_count: 1,
      total: 2,
    });
  });

  it('coalesces symmetric-relation cooldown_key variants into ONE relation cell', async () => {
    const db = testDb();
    // related_to is symmetric; edgeCooldownKeys emits sorted + directional +
    // reversed variants. They must roll up to a single related_to cell.
    await recordProposalDecisionSignal(
      db,
      {
        id: 'e1',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:a|b|related_to' },
      },
      'dismiss',
      'noise',
    );
    await recordProposalDecisionSignal(
      db,
      {
        id: 'e1',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:b|a|related_to' },
      },
      'dismiss',
      'noise',
    );

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const cells = digest.filter((c) => c.kind === 'knowledge_edge' && c.relation === 'related_to');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ accept_count: 0, dismiss_count: 2, total: 2 });
  });

  it('emits top_dismiss_reasons ONLY for net-negative cells', async () => {
    const db = testDb();
    // net-negative: 0 accept / 2 dismiss → reasons surface.
    await recordProposalDecisionSignal(
      db,
      { id: 'n1', kind: 'completion', payload: { cooldown_key: 'completion:neg' } },
      'dismiss',
      'wrong target',
    );
    // net-positive: 3 accept / 1 dismiss → reasons suppressed (stale-reason guard).
    for (let i = 0; i < 3; i++) {
      await recordProposalDecisionSignal(
        db,
        { id: 'p3', kind: 'relearn', payload: { cooldown_key: 'relearn:pos' } },
        'accept',
      );
    }
    await recordProposalDecisionSignal(
      db,
      { id: 'p3', kind: 'relearn', payload: { cooldown_key: 'relearn:pos' } },
      'dismiss',
      'changed my mind later',
    );

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const neg = digest.find((c) => c.kind === 'completion');
    const pos = digest.find((c) => c.kind === 'relearn');
    expect(neg?.top_dismiss_reasons).toContain('wrong target');
    expect(pos?.top_dismiss_reasons).toEqual([]);
  });

  it('surfaces edge-only top_rubric_gates from the rubric_rejected bucket, capped', async () => {
    const db = testDb();
    // A net-negative prerequisite edge in proposal_signals.
    await recordProposalDecisionSignal(
      db,
      {
        id: 'pg',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:x|y|prerequisite' },
      },
      'dismiss',
      'no order evidence',
    );
    // Two folded rubric_rejected propose events on the same relation (suffix
    // |prerequisite), with rubric_verdict.ok = false carrying a gate.
    await writeAiProposal(db, {
      id: 'rr1',
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposal('x', 'y', 'prerequisite', 'knowledge_edge:x|y|prerequisite'),
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        // Mirror the real foldRubricRejectedEdge event payload: the
        // ProposeKnowledgeEdge schema requires the edge fields + reasoning, and
        // carries the rubric_verdict marker as a sibling.
        payload: {
          from_knowledge_id: 'x',
          to_knowledge_id: 'y',
          relation_type: 'prerequisite',
          weight: 1,
          reasoning: 'r',
          rubric_verdict: { ok: false, gate: 'prerequisite_no_order_evidence', reason: 'r' },
        },
      },
      created_at: new Date('2026-05-20T00:00:00.000Z'),
    });
    await writeAiProposal(db, {
      id: 'rr2',
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposal('x2', 'y2', 'prerequisite', 'knowledge_edge:x2|y2|prerequisite'),
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'x2',
          to_knowledge_id: 'y2',
          relation_type: 'prerequisite',
          weight: 1,
          reasoning: 'r',
          rubric_verdict: { ok: false, gate: 'evidence_level', reason: 'r' },
        },
      },
      created_at: new Date('2026-05-21T00:00:00.000Z'),
    });
    // An ACCEPTED (ok != 'false') propose event on the same relation must NOT
    // surface a gate (it is not in the rejected bucket).
    await writeAiProposal(db, {
      id: 'ok1',
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposal('x3', 'y3', 'prerequisite', 'knowledge_edge:x3|y3|prerequisite'),
      created_at: new Date('2026-05-22T00:00:00.000Z'),
    });

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const cell = digest.find((c) => c.kind === 'knowledge_edge' && c.relation === 'prerequisite');
    expect(cell?.top_rubric_gates).toEqual(
      expect.arrayContaining(['prerequisite_no_order_evidence', 'evidence_level']),
    );
    expect(cell?.top_rubric_gates.length).toBeLessThanOrEqual(BUDGET.maxRubricGatesPerCell);
  });

  it('does not surface rubric gates for non-edge cells (L1 gates only knowledge_edge)', async () => {
    const db = testDb();
    await recordProposalDecisionSignal(
      db,
      { id: 'c3', kind: 'completion', payload: { cooldown_key: 'completion:noedge' } },
      'dismiss',
      'too early',
    );
    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const cell = digest.find((c) => c.kind === 'completion');
    expect(cell?.top_rubric_gates).toEqual([]);
  });
});
