// YUK-440 (A13) U8 — reconcile loop DB tests (real Postgres). End-to-end through the
// REAL producers: writeAiProposal (conjecture) → serveProbeOnce/answerProbe (U3
// probe_result) → reconcileConjecturePredictions. Locks: sequence-1 prediction_score and
// sequence-2 score-free projection anchors are append-only + idempotent, the typed-ledger advances
// (typed-state stays soft no-evidence, never `mastered`), R(t) lives in the score event but
// not the typed-state, and NO FSRS/attempt event is ever written (ND-5).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  answerProbe,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { db } from '@/db/client';
import { event, kc_typed_state } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';

import { resetDb } from '../../../tests/helpers/db';
import { PREDICTION_SCORE_ACTION, reconcileConjecturePredictions } from './reconcile';

interface SeedOpts {
  knowledgeId?: string;
  outcome?: 0 | 1;
  predicted_p?: number;
  baseline_p?: number;
  retrievability?: number | null;
}

/** Seed one conjecture + its served-then-answered probe via the real producers. */
async function seedAnsweredProbe(opts: SeedOpts = {}) {
  const knowledgeId = opts.knowledgeId ?? 'k_a';
  const conjectureProposalId = await writeAiProposal(db, {
    actor_ref: 'research_meeting',
    outcome: 'partial',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: knowledgeId },
      reason_md: '你把链式法则当导数相乘',
      evidence_refs: [{ kind: 'event', id: 'att_1' }],
      proposed_change: {
        claim_md: '你把链式法则当导数相乘',
        knowledge_id: knowledgeId,
        cause_category: 'concept_confusion',
        confidence: 0.66,
        recurrence_count: 3,
        probe_md: 'probe text',
        probe_reference_md: 'reference text',
        followup_probe_md: 'independent follow-up probe text',
        followup_probe_reference_md: 'independent follow-up reference text',
        discriminating: true,
        corrected_by_owner: false,
        predicted_p: opts.predicted_p ?? 0.3,
        baseline_p_at_induction: opts.baseline_p ?? 0.7,
      },
      cooldown_key: `conjecture:concept_confusion::${knowledgeId}`,
    },
    caused_by_event_id: null,
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

  const served = await serveProbeOnce({
    db,
    conjectureProposalId,
    knowledgeId,
    probeMd: 'probe text',
    referenceMd: 'reference text',
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);

  const answered = await answerProbe({
    db,
    probeQuestionId: served.probe_question_id,
    outcome: opts.outcome ?? 0,
    retrievabilityAtJudge: opts.retrievability ?? null,
  });

  return {
    conjectureProposalId,
    probeQuestionId: served.probe_question_id,
    probeResultEventId: answered.probe_result_event_id,
    knowledgeId,
  };
}

async function typedRow(subjectId: string) {
  const rows = await db
    .select()
    .from(kc_typed_state)
    .where(
      and(eq(kc_typed_state.subject_kind, 'knowledge'), eq(kc_typed_state.subject_id, subjectId)),
    );
  return rows[0] ?? null;
}

async function scoreEvents(probeResultEventId: string) {
  return db
    .select()
    .from(event)
    .where(
      and(eq(event.action, PREDICTION_SCORE_ACTION), eq(event.subject_id, probeResultEventId)),
    );
}

describe('reconcileConjecturePredictions (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('is idempotent — a second run scores nothing and writes no duplicate', async () => {
    const seed = await seedAnsweredProbe();

    const r1 = await reconcileConjecturePredictions(db);
    expect(r1.reconciled).toBe(1);

    const r2 = await reconcileConjecturePredictions(db);
    expect(r2).toEqual({ reconciled: 0, skipped: 0 });

    const scores = await scoreEvents(seed.probeResultEventId);
    expect(scores).toHaveLength(1); // still exactly one — no duplicate score
  });

  it('is retry-safe on partial failure: anchor-last → no lost ledger, no duplicate score (review fix)', async () => {
    const seed = await seedAnsweredProbe();

    // Simulate a crash AFTER the upsert but BEFORE the score anchor: inject a writeEventFn
    // that throws. The real default upsert commits the ledger advance; the score event is
    // never written; the write error propagates (NOT swallowed) so reconcile throws.
    await expect(
      reconcileConjecturePredictions(db, {
        writeEventFn: async () => {
          throw new Error('crash before anchor');
        },
      }),
    ).rejects.toThrow();

    // Ledger advanced (upsert committed) but NO prediction_score anchor exists yet.
    const afterCrash = await typedRow('k_a');
    expect(afterCrash?.evidence_event_ids).toHaveLength(2);
    expect(await scoreEvents(seed.probeResultEventId)).toHaveLength(0);

    // Retry with the real writer: the reader still returns the probe (no anchor), so the
    // idempotent upsert re-runs harmlessly and the anchor is finally written — self-healing.
    const retry = await reconcileConjecturePredictions(db);
    expect(retry).toEqual({ reconciled: 1, skipped: 0 });
    expect(await scoreEvents(seed.probeResultEventId)).toHaveLength(1); // exactly one, no dup
    const final = await typedRow('k_a');
    expect([...(final?.evidence_event_ids ?? [])].sort()).toEqual(
      [seed.conjectureProposalId, seed.probeResultEventId].sort(),
    ); // evidence NOT duplicated by the retried upsert
  });

  it('deterministic anchor id → concurrent reconcile runs write exactly one score event (review fix)', async () => {
    const seed = await seedAnsweredProbe();

    // Two overlapping runs both pass the list-stage NOT EXISTS (neither has written the
    // anchor yet); the deterministic prediction_score id + onConflictDoNothing(event.id)
    // makes the second insert a no-op → exactly-once, no duplicate score from the race.
    await Promise.all([reconcileConjecturePredictions(db), reconcileConjecturePredictions(db)]);

    const scores = await scoreEvents(seed.probeResultEventId);
    expect(scores).toHaveLength(1);
    expect(scores[0].id).toBe(`prediction_score:${seed.probeResultEventId}`);
  });
});
