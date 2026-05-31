// P5.4-L2 / YUK-174 — DB-partition coverage for getProposalFeedbackDigest:
// per-(kind, relation) resolve from cooldown_key, symmetric-relation coalescing,
// net-negative dismiss-reason gating, edge-only rubric gates from the
// rubric_rejected bucket, and the cold-start empty list. Imports tests/helpers/db
// → DB partition (NOT in fastTestInclude; the pure decision helpers are covered
// by adaptive-bias.unit.test.ts).

import type { AiProposalPayloadInputT } from '@/core/schema/proposal';
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/server/ai/tools/budgets';
import { recordProposalDecisionSignal } from '@/server/proposals/signals';
import { writeAiProposal } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getProposalFeedbackDigest, resolveEdgeGateBump } from './adaptive-bias';

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

  it('surfaces a rubric-only edge cell for a relation with NO proposal_signals row (codex#1)', async () => {
    const db = testDb();
    // A relation whose proposals were ALL rubric-rejected before reaching the
    // decidable inbox: there is NO proposal_signals row for it (it was never
    // accepted/dismissed). Its top_rubric_gates must still surface so the agents
    // can self-correct, even though total === 0.
    await writeAiProposal(db, {
      id: 'rr-only',
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposal('m', 'n', 'prerequisite', 'knowledge_edge:m|n|prerequisite'),
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'm',
          to_knowledge_id: 'n',
          relation_type: 'prerequisite',
          weight: 1,
          reasoning: 'r',
          rubric_verdict: { ok: false, gate: 'prerequisite_no_order_evidence', reason: 'r' },
        },
      },
      created_at: new Date('2026-05-20T00:00:00.000Z'),
    });

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const cell = digest.find((c) => c.kind === 'knowledge_edge' && c.relation === 'prerequisite');
    expect(cell).toBeDefined();
    expect(cell?.total).toBe(0);
    expect(cell?.acceptance_rate).toBe(0);
    expect(cell?.top_rubric_gates).toContain('prerequisite_no_order_evidence');
  });

  it('matches the rejected bucket by relation EQUALITY, not LIKE (codex#4: `_` is not a wildcard)', async () => {
    const db = testDb();
    // The target relation `experimental:foo_bar` contains `_` (a LIKE single-char
    // wildcard). The OLD `cooldown_key LIKE '%|' || relation` predicate would also
    // match `experimental:fooXbar` (the `_` matches the `X`), so a reject on that
    // distinct relation would bleed into the target's gates. Equality on the
    // derived `|`-segment must keep them separate. Both relations are schema-valid
    // via the `experimental:*` escape hatch (RelationTypeSchema), so writeAiProposal
    // parses them. (Core enum relations like `related_to` have no valid same-shape
    // near-match to demonstrate the wildcard with, hence the experimental pair.)
    await recordProposalDecisionSignal(
      db,
      {
        id: 'rl1',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:a|b|experimental:foo_bar' },
      },
      'dismiss',
      'dumping ground',
    );
    // Reject event on experimental:foo_bar → should surface.
    await writeAiProposal(db, {
      id: 'rr-rel',
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposal(
        'a',
        'b',
        'experimental:foo_bar',
        'knowledge_edge:a|b|experimental:foo_bar',
      ),
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'a',
          to_knowledge_id: 'b',
          relation_type: 'experimental:foo_bar',
          weight: 1,
          reasoning: 'r',
          rubric_verdict: { ok: false, gate: 'edge_endpoint_untouched', reason: 'r' },
        },
      },
      created_at: new Date('2026-05-20T00:00:00.000Z'),
    });
    // Reject event on experimental:fooXbar (a `_`-wildcard near-match under the OLD
    // LIKE predicate) → must NOT bleed into experimental:foo_bar's gates.
    await writeAiProposal(db, {
      id: 'rr-xo',
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposal(
        'c',
        'd',
        'experimental:fooXbar',
        'knowledge_edge:c|d|experimental:fooXbar',
      ),
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'c',
          to_knowledge_id: 'd',
          relation_type: 'experimental:fooXbar',
          weight: 1,
          reasoning: 'r',
          rubric_verdict: { ok: false, gate: 'wrong_relation_gate', reason: 'r' },
        },
      },
      created_at: new Date('2026-05-21T00:00:00.000Z'),
    });

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const target = digest.find(
      (c) => c.kind === 'knowledge_edge' && c.relation === 'experimental:foo_bar',
    );
    expect(target?.top_rubric_gates).toContain('edge_endpoint_untouched');
    expect(target?.top_rubric_gates).not.toContain('wrong_relation_gate');
  });

  it('suppresses a stale dismiss_reason after a later accept on the same cooldown_key (codex#5)', async () => {
    const db = testDb();
    // dismiss-then-accept on ONE cooldown_key: accept nulls cooldown_until but
    // retains the prior dismiss_reason and bumps updated_at (sorts first). The
    // stale reason must NOT surface. Use a net-negative count so the net-negative
    // gate alone would NOT suppress it — only the cooldown_until guard does.
    const key = { id: 'sd', kind: 'completion', payload: { cooldown_key: 'completion:flip' } };
    await recordProposalDecisionSignal(db, key, 'dismiss', 'rejected then reconsidered');
    await recordProposalDecisionSignal(db, key, 'dismiss', 'rejected then reconsidered');
    await recordProposalDecisionSignal(db, key, 'accept');

    const digest = await getProposalFeedbackDigest(db, BUDGET);
    const cell = digest.find((c) => c.kind === 'completion');
    // 0 accept? No — 1 accept / 2 dismiss → net-negative, so the reason WOULD
    // surface if the cooldown_until guard were absent. It must be empty because
    // the latest decision is an accept (cooldown_until nulled).
    expect(cell?.dismiss_count).toBe(2);
    expect(cell?.accept_count).toBe(1);
    expect(cell?.top_dismiss_reasons).toEqual([]);
  });

  it('resolveEdgeGateBump uses a relation-scoped read unaffected by the digest display cap (codex#2/#3)', async () => {
    const db = testDb();
    // Seed MANY high-acceptance edge relations so a digest-then-slice path would
    // sort the one low-acceptance relation we care about off the maxKindRelations
    // tail. The relation-scoped read must still compute its (low) bump.
    for (let r = 0; r < BUDGET.maxKindRelations + 3; r++) {
      const rel = `experimental:hi${r}`;
      for (let i = 0; i < 6; i++) {
        await recordProposalDecisionSignal(
          db,
          {
            id: `hi${r}_${i}`,
            kind: 'knowledge_edge',
            payload: { cooldown_key: `knowledge_edge:a${r}|b${r}|${rel}` },
          },
          'accept',
        );
      }
    }
    // The target low-acceptance relation: 1 accept / 9 dismiss → rate 0.1, 10
    // samples (>= minSamples 5). It sorts LAST by acceptance_rate, so a sliced
    // digest of the top maxKindRelations cells would drop it.
    await recordProposalDecisionSignal(
      db,
      {
        id: 'lo_a',
        kind: 'knowledge_edge',
        payload: { cooldown_key: 'knowledge_edge:lo|lo|contrasts_with' },
      },
      'accept',
    );
    for (let i = 0; i < 9; i++) {
      await recordProposalDecisionSignal(
        db,
        {
          id: `lo_d${i}`,
          kind: 'knowledge_edge',
          payload: { cooldown_key: 'knowledge_edge:lo|lo|contrasts_with' },
        },
        'dismiss',
        'confusion not shown',
      );
    }

    // Confirm the digest (sorted + sliced) would have dropped the low cell.
    const digest = await getProposalFeedbackDigest(db, BUDGET);
    expect(digest.find((c) => c.relation === 'contrasts_with')).toBeUndefined();

    // The relation-scoped resolver still tightens it.
    const bump = await resolveEdgeGateBump(db, 'contrasts_with', BUDGET, PROPOSAL_GATE_BIAS_CONFIG);
    expect(bump).toMatchObject({
      tightenMediumToStrong: true,
      acceptanceRate: 0.1,
      sampleCount: 10,
      threshold: PROPOSAL_GATE_BIAS_CONFIG.acceptanceThreshold,
    });
  });
});
