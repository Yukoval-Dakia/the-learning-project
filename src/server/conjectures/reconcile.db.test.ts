// YUK-440 (A13) U8 — reconcile loop DB tests (real Postgres). End-to-end through the
// REAL producers: writeAiProposal (conjecture) → serveProbeOnce/answerProbe (U3
// probe_result) → reconcileConjecturePredictions. Locks: prediction_score is appended
// LOG-only + idempotent (no duplicate on re-run), the typed-ledger advances
// (FLIP-inert: soft no-evidence, never `mastered`), R(t) lives in the score event but
// not the typed-state, and NO FSRS/attempt event is ever written (ND-5).

import {
  answerProbe,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { db } from '@/db/client';
import { event, kc_typed_state } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from '../../../tests/helpers/db';
import { PREDICTION_SCORE_ACTION, reconcileConjecturePredictions } from './reconcile';

interface SeedOpts {
  knowledgeId?: string;
  outcome?: 0 | 1;
  resolution?: 'confirmed' | 'retired';
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
        discriminating: true,
        corrected_by_owner: false,
        predicted_p: opts.predicted_p ?? 0.3,
        baseline_p_at_induction: opts.baseline_p ?? 0.7,
      },
      cooldown_key: `conjecture:concept_confusion::${knowledgeId}`,
    },
    caused_by_event_id: null,
  });

  const served = await serveProbeOnce({
    db,
    conjectureProposalId,
    knowledgeId,
    probeMd: 'probe text',
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);

  const answered = await answerProbe({
    db,
    probeQuestionId: served.probe_question_id,
    outcome: opts.outcome ?? 0,
    resolution: opts.resolution ?? 'confirmed',
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

  it('scores a confirmed probe → LOG prediction_score + soft typed-ledger cell (FLIP-inert)', async () => {
    const seed = await seedAnsweredProbe({ outcome: 0, retrievability: 0.42 });

    const result = await reconcileConjecturePredictions(db);
    expect(result).toEqual({ reconciled: 1, skipped: 0 });

    // (1) one LOG-only prediction_score event keyed on the probe_result id.
    const scores = await scoreEvents(seed.probeResultEventId);
    expect(scores).toHaveLength(1);
    const p = scores[0].payload as Record<string, unknown>;
    expect(p.conjecture_event_id).toBe(seed.conjectureProposalId);
    expect(p.knowledge_id).toBe('k_a');
    expect(p.predicted_p).toBe(0.3);
    expect(p.baseline_p).toBe(0.7);
    expect(p.outcome).toBe(0);
    expect(p.brier_model).toBeCloseTo(0.09, 9);
    expect(p.brier_baseline).toBeCloseTo(0.49, 9);
    // R(t) recorded HERE (in the log event).
    expect(p.retrievability_at_judge).toBe(0.42);
    // Envelope outcome must be null — a score event is NOT an attempt (ND-5).
    expect(scores[0].outcome ?? null).toBeNull();

    // (2) typed-ledger cell: soft (confused_with null → §修正-4 gate), never `mastered`.
    const ts = await typedRow('k_a');
    expect(ts?.typed_state).toBe('no-evidence');
    expect(ts?.lifecycle).toBe('open');
    expect(ts?.confused_with_kc_id).toBeNull();
    expect([...(ts?.evidence_event_ids ?? [])].sort()).toEqual(
      [seed.conjectureProposalId, seed.probeResultEventId].sort(),
    );
    // R(t) is NOT a column of kc_typed_state — it never leaks into written state.
    expect('retrievability_at_judge' in (ts ?? {})).toBe(false);

    // (3) ND-5: no FSRS / attempt event was written anywhere in the loop.
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(0);
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

  it('a retired probe still writes a soft no-evidence cell', async () => {
    await seedAnsweredProbe({ knowledgeId: 'k_ret', outcome: 1, resolution: 'retired' });
    const result = await reconcileConjecturePredictions(db);
    expect(result.reconciled).toBe(1);
    const ts = await typedRow('k_ret');
    expect(ts?.typed_state).toBe('no-evidence');
    expect(ts?.lifecycle).toBe('open');
  });

  it('skips a probe_result whose conjecture ref is dangling (never throws)', async () => {
    // A probe_result event pointing at a non-existent conjecture (data anomaly).
    const probeResultEventId = 'pr_dangling';
    await db.insert(event).values({
      id: probeResultEventId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: 'q_ghost',
      payload: {
        conjecture_event_id: 'cj_ghost',
        outcome: 0,
        resolution: 'confirmed',
        retrievability_at_judge: null,
        answer_md: null,
      },
      caused_by_event_id: 'cj_ghost',
      created_at: new Date('2026-06-26T10:00:00Z'),
    });

    const result = await reconcileConjecturePredictions(db);
    expect(result).toEqual({ reconciled: 0, skipped: 1 });
    const scores = await scoreEvents(probeResultEventId);
    expect(scores).toHaveLength(0);
  });
});
