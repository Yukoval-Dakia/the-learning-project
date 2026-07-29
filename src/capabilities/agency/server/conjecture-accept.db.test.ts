// Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept applier lifecycle.
// Enters through the public dispatch shell (acceptAiProposal / dismissAiProposal)
// to cover the whole 「壳路由 → agency applier」 chain. Asserts the three
// semantics (accept = calibration anchor / edit → mem0 CORE / reject → digest),
// idempotency, and the ND-5 red line: NO FSRS / review row is ever written.

import {
  CONJECTURE_PROBE_QUALITY_REQUIRED_CODE,
  PROBE_SLOTS_FULL_CODE,
  acceptConjectureProposal,
} from '@/capabilities/agency/server/conjecture-accept';
import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  answerProbe,
  countActiveProbes,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import {
  DEFAULT_MISCONCEPTION_WEIGHT,
  misconceptionIdForConjecture,
  promoteConjectureToMisconception,
} from '@/capabilities/agency/server/misconception-promote';
import { createMisconceptionEdge } from '@/capabilities/knowledge/server/misconception-edges';
import { loadPrepDeskConjectures } from '@/capabilities/shell/server/prep-desk';
import {
  event,
  material_fsrs_state,
  misconception,
  misconception_edge,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

function baseConjecture() {
  const primaryProbeSpec = {
    prompt_md: 'd/dx sin(x^2) = ?',
    reference_md: '2x·cos(x^2) — outer cos × inner 2x (chain rule: outer-deriv × inner-deriv).',
    expected_target_error_answer_md: 'cos(x²) + 2x',
    elicits_target_error_reason_md: 'Requires composing the two derivative layers.',
    context_kind: 'abstract' as const,
    representation_kind: 'symbolic' as const,
  };
  const followupProbeSpec = {
    prompt_md: 'A changing area follows cos(t^3); explain its instantaneous rate.',
    reference_md: '-3t²·sin(t³), with outer and inner derivatives multiplied.',
    expected_target_error_answer_md: '-sin(t³) + 3t²',
    elicits_target_error_reason_md: 'Retains the same layer-composition decision in context.',
    context_kind: 'applied' as const,
    representation_kind: 'natural_language' as const,
  };
  return {
    kind: 'conjecture' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: 'kn_chain_rule' },
    reason_md: 'recurrent cause×KC failure cell + low θ precision',
    evidence_refs: [
      { kind: 'event' as const, id: 'evt_a' },
      { kind: 'event' as const, id: 'evt_b' },
    ],
    cooldown_key: 'conjecture:kn_chain_rule',
    proposed_change: {
      claim_md: 'you treat the chain rule as multiplying derivatives',
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
      confidence: 0.7,
      recurrence_count: 2,
      probe_md: 'd/dx sin(x^2) = ?',
      probe_reference_md:
        '2x·cos(x^2) — outer cos × inner 2x (chain rule: outer-deriv × inner-deriv).',
      followup_probe_md: 'A changing area follows cos(t^3); explain its instantaneous rate.',
      followup_probe_reference_md: '-3t²·sin(t³), with outer and inner derivatives multiplied.',
      diagnostic_spec: {
        schema_version: 1 as const,
        target_error_rule_md: 'Adds outer and inner derivatives instead of multiplying them.',
        trigger_conditions_md: 'A composite function must be differentiated.',
        scope_boundary_md: 'Does not claim other differentiation rules are misunderstood.',
        expected_wrong_answer_signature_md: 'Outer derivative + inner derivative.',
      },
      probe_spec: primaryProbeSpec,
      followup_probe_spec: followupProbeSpec,
      probe_quality: {
        schema_version: 2 as const,
        passed: true as const,
        attempts: [
          {
            attempt: 1,
            outcome: 'passed' as const,
            failure_codes: [],
            explanation_md: 'verified',
            author_task_run_id: 'author_run',
            reviewer_task_run_id: 'review_run',
          },
        ],
        final_review: {
          verdict: 'pass' as const,
          failure_codes: [],
          explanation_md: 'verified',
        },
        reviewed_package: {
          primary: primaryProbeSpec,
          followup: followupProbeSpec,
          predicted_p: 0.3,
        },
      },
      discriminating: true,
      predicted_p: 0.3,
      baseline_p_at_induction: 0.6,
    },
  };
}

async function rateEvents(proposalId: string) {
  const db = testDb();
  return db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
}

async function fsrsRowCount(): Promise<number> {
  const db = testDb();
  const rows = await db.select().from(material_fsrs_state);
  return rows.length;
}

async function misconceptionRows() {
  return testDb().select().from(misconception);
}

async function misconceptionEdgeRows() {
  return testDb().select().from(misconception_edge);
}

/** Probe questions served for a specific conjecture (source_ref = the proposal id). */
async function probeQuestionsFor(proposalId: string) {
  const db = testDb();
  return db
    .select()
    .from(question)
    .where(and(eq(question.source, PROBE_QUESTION_SOURCE), eq(question.source_ref, proposalId)));
}

async function allProbeQuestions() {
  return testDb().select().from(question).where(eq(question.source, PROBE_QUESTION_SOURCE));
}

/**
 * Fill N active mind_probe slots from well-formed package-bound conjectures. The cap
 * counts unanswered questions, while answerProbe also verifies the proposal provenance;
 * seeding the proposal keeps the fixture representative instead of relying on an orphan.
 * Returns the served probe question ids so a test can answer one to free a slot.
 */
async function fillProbeSlots(n: number): Promise<string[]> {
  const db = testDb();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const conjectureProposalId = `cj_fill_${i}`;
    const payload = baseConjecture();
    await writeAiProposal(db, {
      id: conjectureProposalId,
      actor_ref: 'research_meeting',
      payload: {
        ...payload,
        cooldown_key: `conjecture:fill:${i}`,
        proposed_change: {
          ...payload.proposed_change,
          probe_md: `filler probe ${i}`,
          probe_reference_md: 'ref',
          probe_spec: {
            ...payload.proposed_change.probe_spec,
            prompt_md: `filler probe ${i}`,
            reference_md: 'ref',
          },
          probe_quality: {
            ...payload.proposed_change.probe_quality,
            reviewed_package: {
              ...payload.proposed_change.probe_quality.reviewed_package,
              primary: {
                ...payload.proposed_change.probe_spec,
                prompt_md: `filler probe ${i}`,
                reference_md: 'ref',
              },
            },
          },
        },
      },
    });
    await writeEvent(db, {
      id: `rate_${conjectureProposalId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: conjectureProposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        conjecture_id: conjectureProposalId,
        calibration_anchor: 'accept',
      },
      caused_by_event_id: conjectureProposalId,
    });
    const r = await serveProbeOnce({
      db,
      conjectureProposalId,
      knowledgeId: 'kn_chain_rule',
      probeMd: `filler probe ${i}`,
      referenceMd: 'ref',
    });
    if (r.status !== 'served') throw new Error(`expected served filler, got ${r.status}`);
    ids.push(r.probe_question_id);
  }
  return ids;
}

describe('acceptConjectureProposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
    // YUK-531 PR-3 — every test starts with the promotion flag OFF (dark default).
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
  });

  it('plain accept writes corrected_by_owner=false, no CORE write, no FSRS row', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    const result = await acceptAiProposal(db, proposalId);

    expect(result).toMatchObject({
      kind: 'conjecture',
      conjecture_id: proposalId,
      corrected_by_owner: false,
      weakness_confirmed: false,
    });

    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({
      rating: 'accept',
      conjecture_id: proposalId,
      corrected_by_owner: false,
      calibration_anchor: 'accept',
    });

    // Accept is durably projected from this rate event by the worker outbox.
    expect(await fsrsRowCount()).toBe(0);
  });

  it('fails closed for an unaccepted historical proposal without the v3 probe-quality packet', async () => {
    const db = testDb();
    const payload = baseConjecture();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: {
        ...payload,
        proposed_change: {
          ...payload.proposed_change,
          diagnostic_spec: undefined,
          probe_spec: undefined,
          followup_probe_spec: undefined,
          probe_quality: undefined,
        },
      },
    });

    await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
      code: CONJECTURE_PROBE_QUALITY_REQUIRED_CODE,
      status: 409,
      message: expect.stringMatching(
        /diagnostic_spec_invalid.*primary_probe_spec_invalid.*followup_probe_spec_invalid.*probe_quality_audit_invalid.*reprepare/,
      ),
    });
    expect(await rateEvents(proposalId)).toHaveLength(0);
    expect(await probeQuestionsFor(proposalId)).toHaveLength(0);
  });

  it('keeps a v1 audit readable but refuses to use it for a new accept decision', async () => {
    const db = testDb();
    const payload = baseConjecture();
    const { reviewed_package: _reviewedPackage, ...historicalAudit } =
      payload.proposed_change.probe_quality;
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: {
        ...payload,
        proposed_change: {
          ...payload.proposed_change,
          probe_quality: {
            ...historicalAudit,
            schema_version: 1,
          },
        },
      },
    });

    await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
      code: CONJECTURE_PROBE_QUALITY_REQUIRED_CODE,
      status: 409,
      message: expect.stringContaining('probe_quality_audit_unbound'),
    });
    expect(await rateEvents(proposalId)).toHaveLength(0);
  });

  it('rejects a passing audit copied from a different probe package', async () => {
    const payload = baseConjecture();
    const tampered = structuredClone(payload);
    tampered.proposed_change.probe_quality.reviewed_package.predicted_p = 0.4;

    await expect(
      acceptConjectureProposal(testDb(), 'tampered_probe_quality', {
        id: 'tampered_probe_quality',
        payload: tampered,
      } as never),
    ).rejects.toMatchObject({
      code: CONJECTURE_PROBE_QUALITY_REQUIRED_CODE,
      status: 409,
      message: expect.stringContaining('probe_quality_package_mismatch'),
    });
    expect(await rateEvents('tampered_probe_quality')).toHaveLength(0);
  });

  it('does not accept a self-declared non-discriminating package even when an audit is present', async () => {
    const db = testDb();
    const payload = baseConjecture();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: {
        ...payload,
        proposed_change: {
          ...payload.proposed_change,
          discriminating: false,
        },
      },
    });

    await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
      code: CONJECTURE_PROBE_QUALITY_REQUIRED_CODE,
      status: 409,
      message: expect.stringContaining('not_discriminating'),
    });
    expect(await rateEvents(proposalId)).toHaveLength(0);
  });

  it('edit persists the owner version on the durable rate event, not confirmed, no FSRS', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    const result = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'you apply the chain rule but drop the inner factor' },
    });

    expect(result).toMatchObject({
      kind: 'conjecture',
      corrected_by_owner: true,
      weakness_confirmed: false,
    });

    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({
      rating: 'accept',
      corrected_by_owner: true,
      calibration_anchor: 'edit',
      corrected_claim_md: 'you apply the chain rule but drop the inner factor',
    });

    // edit is still NOT a confirmed weakness — ND-5: no FSRS row.
    expect(await fsrsRowCount()).toBe(0);
  });

  it('reject dismisses with reason and never mints a weakness or CORE write', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    const result = await dismissAiProposal(db, proposalId, {
      user_note: 'wrong, I never confuse those',
    });

    expect(result.kind).toBe('dismissed');

    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({
      rating: 'dismiss',
      user_note: 'wrong, I never confuse those',
    });

    expect(await fsrsRowCount()).toBe(0);
  });

  it('re-accept is idempotent — single durable rate event and no FSRS', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });
    const again = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });

    expect(again).toMatchObject({ idempotent: true, corrected_by_owner: true });
    // Exactly one rate event survives — no double-anchor.
    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(await fsrsRowCount()).toBe(0);
  });

  // YUK-531 PR-3 — the dark, flag-gated misconception promotion hop.
  describe('misconception promotion (YUK-531 PR-3)', () => {
    it('flag OFF (default) — accept mints NO misconception and NO edge (dark regression)', async () => {
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);

      // Flag OFF ⇒ byte-identical to pre-PR-3: rate event written, zero promotion side-effects.
      const rates = await rateEvents(proposalId);
      expect(rates).toHaveLength(1);
      expect(await misconceptionRows()).toHaveLength(0);
      expect(await misconceptionEdgeRows()).toHaveLength(0);
      expect(await fsrsRowCount()).toBe(0);
    });

    it('flag ON — plain accept mints a soft/active misconception + caused_by edge, still no FSRS', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);

      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      const m = miscs[0];
      expect(m.title).toBe('you treat the chain rule as multiplying derivatives');
      // SOFT track, owner-accepted live node, recurrence salience, conjecture evidence ptrs.
      expect(m.source).toBe('soft');
      expect(m.status).toBe('active');
      expect(m.seen).toBe(2);
      expect(m.evidence).toEqual(['evt_a', 'evt_b']);
      expect(m.proposed_by_ai).toBe(true);

      const edges = await misconceptionEdgeRows();
      expect(edges).toHaveLength(1);
      const e = edges[0];
      expect(e.from_kind).toBe('misconception');
      expect(e.from_id).toBe(m.id);
      expect(e.to_kind).toBe('knowledge');
      expect(e.to_id).toBe('kn_chain_rule');
      expect(e.relation_type).toBe('caused_by');
      expect(e.archived_at).toBeNull();

      // ND-5 red line holds even on the promotion path — no FSRS/review row.
      expect(await fsrsRowCount()).toBe(0);
    });

    it('flag ON — re-accept is idempotent: one misconception, one edge, one rate', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);
      await acceptAiProposal(db, proposalId);

      // The rate-event idempotency guard short-circuits the 2nd accept BEFORE the
      // promotion hop, so nothing double-writes.
      expect(await rateEvents(proposalId)).toHaveLength(1);
      expect(await misconceptionRows()).toHaveLength(1);
      expect(await misconceptionEdgeRows()).toHaveLength(1);
    });

    // YUK-785 — this flag is a dark landmine: OFF today, so whatever an edited accept
    // mints would ship silently the day it is flipped. An edit must mint NOTHING: the
    // rewrite has no evidence of its own (titling with it would hang evt_a/evt_b's
    // provenance off an unevidenced belief), and the original claim is exactly what the
    // owner declined to accept as worded (persisting it as an active misconception would
    // park a corrected belief in the knowledge surface). Neither harm is committed.
    it('flag ON — edit accept mints NO misconception (neither the rewrite nor the original)', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId, {
        corrected_payload: { claim_md: 'you apply the chain rule but drop the inner factor' },
      });

      // No node, no edge — flag ON but the edit path never enters the promote hop.
      expect(await misconceptionRows()).toHaveLength(0);
      expect(await misconceptionEdgeRows()).toHaveLength(0);
      // The accept itself still happened, and the rewrite stays durable on the rate
      // event, so an edited accept remains findable for a later re-evidencing pass.
      const rates = await rateEvents(proposalId);
      expect(rates).toHaveLength(1);
      expect(rates[0].payload).toMatchObject({
        corrected_by_owner: true,
        calibration_anchor: 'edit',
        corrected_claim_md: 'you apply the chain rule but drop the inner factor',
      });
      // ND-5 unchanged: an edit never confirms a weakness.
      expect(await fsrsRowCount()).toBe(0);
    });

    it('flag ON — edit archives a pre-existing same-identity soft node and its live edge', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const firstProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, firstProposal);

      const secondProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, secondProposal, {
        corrected_payload: { claim_md: 'you drop the inner factor only under time pressure' },
      });

      const [node] = await misconceptionRows();
      const [edge] = await misconceptionEdgeRows();
      expect(node.source).toBe('soft');
      expect(node.archived_at).not.toBeNull();
      expect(edge.archived_at).not.toBeNull();
      expect(node.title).toBe('you treat the chain rule as multiplying derivatives');
    });

    it('flag ON create → flag OFF edit still archives the stale soft node and live edge', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const firstProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, firstProposal);

      // Simulate rollback after the soft row already exists. Cleanup must follow persisted
      // state, not the current writer flag.
      // biome-ignore lint/performance/noDelete: test the real flag-off transition.
      delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
      const secondProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, secondProposal, {
        corrected_payload: { claim_md: 'you drop the inner factor only under time pressure' },
      });

      const [node] = await misconceptionRows();
      const [edge] = await misconceptionEdgeRows();
      expect(node.source).toBe('soft');
      expect(node.archived_at).not.toBeNull();
      expect(edge.archived_at).not.toBeNull();
    });

    it('flag OFF edit cleans live edges even when the soft node was already archived', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const firstProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, firstProposal);
      const [node] = await misconceptionRows();
      await db
        .update(misconception)
        .set({ archived_at: new Date('2026-07-26T01:00:00.000Z') })
        .where(eq(misconception.id, node.id));

      // A later plain promotion preserves the tombstone but reactivates caused_by.
      const plainAgain = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, plainAgain);
      expect((await misconceptionEdgeRows()).some((edge) => edge.archived_at === null)).toBe(true);

      // biome-ignore lint/performance/noDelete: test rollback cleanup against persisted state.
      delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
      const editProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, editProposal, {
        corrected_payload: { claim_md: 'owner disputes this cell description' },
      });

      expect((await misconceptionEdgeRows()).every((edge) => edge.archived_at !== null)).toBe(true);
    });

    it('edit archives both outgoing and incoming live edges of the stale soft node', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, proposalId);
      const targetId = misconceptionIdForConjecture('concept_misunderstanding', 'kn_chain_rule');
      await db.transaction(async (tx) => {
        await promoteConjectureToMisconception(tx, {
          conjectureId: 'cj_neighbor',
          knowledgeId: 'kn_other',
          claimMd: 'neighbor misconception',
          causeCategory: 'misread_prompt',
          confidence: 0.6,
          recurrenceCount: 2,
          evidenceEventIds: ['evt_neighbor'],
          now: new Date('2026-07-26T02:00:00.000Z'),
        });
        await createMisconceptionEdge(tx, {
          from_id: targetId,
          to_kind: 'misconception',
          to_id: misconceptionIdForConjecture('misread_prompt', 'kn_other'),
          relation_type: 'confusable_with',
          weight: 0.5,
          created_by: { by: 'ai' },
          proposed_by_ai: true,
          now: new Date('2026-07-26T02:00:00.000Z'),
        });
      });

      const editProposal = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, editProposal, {
        corrected_payload: { claim_md: 'owner disputes this cell description' },
      });

      const touchingTarget = (await misconceptionEdgeRows()).filter(
        (edge) => edge.from_id === targetId || edge.to_id === targetId,
      );
      expect(touchingTarget.length).toBeGreaterThanOrEqual(2);
      expect(touchingTarget.every((edge) => edge.archived_at !== null)).toBe(true);
    });

    it('flag ON — edit never archives a pre-existing hard-confirmed same-identity node', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      await db.transaction(async (tx) => {
        await promoteConjectureToMisconception(tx, {
          conjectureId: 'cj_hard',
          knowledgeId: 'kn_chain_rule',
          claimMd: 'hard-confirmed claim',
          causeCategory: 'concept_misunderstanding',
          confidence: 0.9,
          recurrenceCount: 3,
          evidenceEventIds: ['evt_hard'],
          source: 'hard',
          now: new Date('2026-07-26T00:00:00.000Z'),
        });
      });

      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, proposalId, {
        corrected_payload: { claim_md: 'owner wording differs' },
      });

      const [node] = await misconceptionRows();
      const [edge] = await misconceptionEdgeRows();
      expect(node.source).toBe('hard');
      expect(node.archived_at).toBeNull();
      expect(edge.archived_at).toBeNull();
      expect(node.title).toBe('hard-confirmed claim');
    });

    // YUK-785 (codex #1080) — "edit" is decided by CONTENT, not payload presence. The
    // public schema accepts a corrected_payload identical to the original (only the UI
    // disables that button). Both boundaries trim now, and the normalized comparison remains
    // defense in depth for direct callers and legacy rows. Keying off presence previously
    // made the accept path and brief reader give one no-op accept two different verdicts.
    it.each([
      ['identical', 'you treat the chain rule as multiplying derivatives'],
      ['whitespace-only', '  you treat the chain rule as multiplying derivatives  '],
    ])(
      'flag ON — a %s corrected_payload is NOT an edit: promotes, records no correction',
      async (_label, submitted) => {
        process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
        const db = testDb();
        const proposalId = await writeAiProposal(db, {
          actor_ref: 'research_meeting',
          payload: baseConjecture(),
        });

        const result = await acceptAiProposal(db, proposalId, {
          corrected_payload: { claim_md: submitted },
        });

        // Treated as a PLAIN accept end to end.
        expect(result).toMatchObject({ corrected_by_owner: false });
        const rates = await rateEvents(proposalId);
        expect(rates[0].payload).toMatchObject({
          corrected_by_owner: false,
          calibration_anchor: 'accept',
        });
        // A no-op is not a correction, so nothing claims the owner rewrote anything.
        expect(rates[0].payload).not.toHaveProperty('corrected_claim_md');
        // …and promotion is NOT skipped (the edit-skip must not swallow a no-op).
        const miscs = await misconceptionRows();
        expect(miscs).toHaveLength(1);
        expect(miscs[0].title).toBe('you treat the chain rule as multiplying derivatives');
      },
    );

    // The skip is scoped to EDIT accepts only — a plain accept still promotes, so the
    // guard above cannot quietly disable the whole dark track.
    it('flag ON — a PLAIN accept still promotes on the proposal claim (skip is edit-only)', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);

      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      expect(miscs[0].title).toBe('you treat the chain rule as multiplying derivatives');
      expect(miscs[0].evidence).toEqual(['evt_a', 'evt_b']);
      expect(miscs[0].source).toBe('soft');
    });

    it('flag ON — two DISTINCT proposals sharing cause×KC collapse to ONE misconception (cross-proposal UPSERT refreshes seen/evidence)', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();

      // Proposal A: the baseConjecture default — recurrence 2, evidence evt_a/evt_b.
      const proposalA = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, proposalA);

      // Proposal B: a DIFFERENT proposal (fresh id) for the SAME cause×KC, with a higher
      // recurrence_count + fresh evidence — the cross-proposal re-induction case (NOT a
      // re-accept of the same proposal, which short-circuits at the rate guard BEFORE the
      // promote hop, so the onConflictDoUpdate SET branch only fires on this path).
      const second = baseConjecture();
      second.evidence_refs = [
        { kind: 'event' as const, id: 'evt_c' },
        { kind: 'event' as const, id: 'evt_d' },
        { kind: 'event' as const, id: 'evt_e' },
      ];
      second.proposed_change.recurrence_count = 3;
      const proposalB = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: second,
      });
      expect(proposalB).not.toBe(proposalA);
      await acceptAiProposal(db, proposalB);

      // Deterministic id keyed on cause×KC ⇒ both accepts UPSERT the SAME row: exactly
      // ONE misconception survives, refreshed to the SECOND accept's salience snapshot.
      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      const m = miscs[0];
      expect(m.seen).toBe(3);
      expect(m.evidence).toEqual(['evt_c', 'evt_d', 'evt_e']);
      expect(m.status).toBe('active');
      expect(m.source).toBe('soft');
      expect(m.archived_at).toBeNull();

      // And exactly ONE caused_by edge to the shared KC (idempotent / un-archived).
      const edges = await misconceptionEdgeRows();
      expect(edges).toHaveLength(1);
      expect(edges[0].relation_type).toBe('caused_by');
      expect(edges[0].to_id).toBe('kn_chain_rule');
      expect(edges[0].archived_at).toBeNull();
    });

    it('flag ON — promoting a conjecture with NaN/missing confidence does NOT throw; mints at the default weight', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();

      // A legacy / hand-crafted conjecture missing `confidence` reaches the promote hop as
      // NaN (Number(undefined)). Pre-guard this threw a ZodError (the weight Zod rejects
      // NaN) that rolled back the owner's WHOLE accept — a 500. Drive the writer directly
      // with NaN (writeAiProposal's Zod would reject a missing-confidence payload, so a raw
      // legacy row is the only way it occurs) to prove the clamp-with-default guard: no
      // throw, a sane weight on BOTH the node and its caused_by edge.
      const result = await db.transaction((tx) =>
        promoteConjectureToMisconception(tx, {
          conjectureId: 'cj_legacy',
          knowledgeId: 'kn_chain_rule',
          claimMd: 'legacy conjecture lacking a confidence field',
          causeCategory: 'concept_misunderstanding',
          confidence: Number.NaN,
          recurrenceCount: 2,
          evidenceEventIds: ['evt_a'],
          now: new Date(),
        }),
      );

      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      expect(miscs[0].id).toBe(result.misconceptionId);
      expect(miscs[0].weight).toBe(DEFAULT_MISCONCEPTION_WEIGHT);

      const edges = await misconceptionEdgeRows();
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(DEFAULT_MISCONCEPTION_WEIGHT);
    });
  });

  // YUK-711 — the probe-slot-cap rollback. When all MAX_CONCURRENT_ACTIVE_PROBES
  // slots are taken, the accept must NOT commit a rate anchor / dark promotion with
  // no probe (the accepted-without-probe dangling chain the idempotency guard then
  // permanently blocks). Instead it throws a typed `probe_slots_full` ApiError inside
  // the accept tx so everything rolls back and the proposal stays pending for retry.
  describe('probe slot cap rollback (YUK-711)', () => {
    it('cap reached — accept throws typed probe_slots_full and rolls back rate + promotion + probe; proposal stays pending', async () => {
      // Flag ON so the dark misconception promotion is in-play and we prove it ALSO
      // rolls back — criterion 2 (zero half-written rate / promotion / probe rows).
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();

      // (1) Seed 3 active mind_probe questions — the cap is at MAX.
      await fillProbeSlots(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);

      // Accept a 4th conjecture → clear retryable typed error (409 probe_slots_full).
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
        code: PROBE_SLOTS_FULL_CODE,
        status: 409,
      });

      // (2) Zero half-written rows for this proposal: no rate anchor, no dark
      // promotion (node + edge), no new probe question. The 3 seeds are untouched.
      expect(await rateEvents(proposalId)).toHaveLength(0);
      expect(await misconceptionRows()).toHaveLength(0);
      expect(await misconceptionEdgeRows()).toHaveLength(0);
      expect(await probeQuestionsFor(proposalId)).toHaveLength(0);
      expect(await allProbeQuestions()).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);

      // (6) ND-5: zero FSRS / mastery state written.
      expect(await fsrsRowCount()).toBe(0);

      // (5) The proposal is STILL pending — it re-appears in the prep-desk feed so the
      // owner can retry in place. No reader sees an accepted-without-probe row because
      // the accept never committed: rate anchor and probe are atomic (both or neither).
      const feed = await loadPrepDeskConjectures(db);
      expect(feed.conjectures.some((c) => c.id === proposalId)).toBe(true);
    });

    it('after a probe is answered a slot frees — retrying the SAME proposal accepts with exactly 1 rate anchor + 1 probe', async () => {
      const db = testDb();
      const seededProbeIds = await fillProbeSlots(MAX_CONCURRENT_ACTIVE_PROBES);

      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      // First accept is capped (and left nothing behind).
      await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
        code: PROBE_SLOTS_FULL_CODE,
      });
      expect(await rateEvents(proposalId)).toHaveLength(0);

      // (3) Retire one active probe → no follow-up is needed, so a slot frees.
      await answerProbe({
        db,
        probeQuestionId: seededProbeIds[0],
        outcome: 1,
      });
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES - 1);

      // Retry the SAME proposal → accept succeeds.
      const result = await acceptAiProposal(db, proposalId);
      expect(result).toMatchObject({
        kind: 'conjecture',
        conjecture_id: proposalId,
        corrected_by_owner: false,
        weakness_confirmed: false,
      });

      // Exactly 1 rate anchor + exactly 1 served probe for this proposal.
      expect(await rateEvents(proposalId)).toHaveLength(1);
      const probes = await probeQuestionsFor(proposalId);
      expect(probes).toHaveLength(1);
      expect(probes[0].draft_status).toBe('draft');
      expect(probes[0].source).toBe(PROBE_QUESTION_SOURCE);

      // (6) ND-5 still holds on the successful retry.
      expect(await fsrsRowCount()).toBe(0);
    });

    it('(4) concurrent accepts are bounded by the advisory lock — exactly MAX succeed, the rest roll back with no orphan rate anchor', async () => {
      const db = testDb();
      // Start from an empty slate and fire MAX+2 accepts of distinct fresh conjectures
      // concurrently. The transaction-scoped advisory lock serializes each serve's
      // count-read + insert, so the cap can never be raced past.
      const overflow = 2;
      const proposalIds = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_ACTIVE_PROBES + overflow }, () =>
          writeAiProposal(db, { actor_ref: 'research_meeting', payload: baseConjecture() }),
        ),
      );

      const settled = await Promise.allSettled(proposalIds.map((id) => acceptAiProposal(db, id)));
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

      // Exactly MAX accepts win a slot; the overflow ones fail with probe_slots_full.
      expect(fulfilled).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(rejected).toHaveLength(overflow);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({ code: PROBE_SLOTS_FULL_CODE, status: 409 });
      }

      // Active probes never exceeded the cap, and the failed accepts left NO orphan
      // rate anchor — exactly MAX rate(accept) events and MAX probe questions survive.
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await allProbeQuestions()).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      const acceptRates = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.subject_kind, 'event')));
      const anchors = acceptRates.filter(
        (e) => (e.payload as { rating?: string }).rating === 'accept',
      );
      expect(anchors).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await fsrsRowCount()).toBe(0);
    });
  });
});
