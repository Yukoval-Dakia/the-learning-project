// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S4 + §10 A4) — admin conjecture-scores reader test.
//
// Asserts the reader's three contracts:
//   1. BOTH halves render (A4 fix): prediction_score LOG events + kc_typed_state
//      confused-with-X rows (the structural state reconcile auto-mints).
//   2. HONEST render: score fields are brier_model / brier_baseline / log_loss_model /
//      skill_score_point + score_basis='single_point' (NOT «accuracy», NOT a window mean).
//   3. READ-ONLY: the route writes nothing (ND-5 — no FSRS, no attempt, no state mutation).
//
// Seeds prediction_score events + kc_typed_state rows DIRECTLY (the reader is the unit
// under test; the reconcile producer is exercised in reconcile.db.test.ts). Fail-closed
// per-field rendering is asserted via a corrupt-score row that must drop (not partially render).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { event, kc_typed_state, knowledge, material_fsrs_state } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { CONJECTURE_SCORES_LIMIT } from '../server/conjecture-scores';
import { GET } from './conjecture-scores';

const KC_ID = 'kn_chain_rule';
const RIVAL_KC = 'kn_product_rule';
const PREDICTION_SCORE_ACTION = 'experimental:prediction_score';

async function seedKnowledge(): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of [KC_ID, RIVAL_KC]) {
    await db
      .insert(knowledge)
      .values({ id, name: id, created_at: now, updated_at: now })
      .onConflictDoNothing();
  }
}

async function seedPredictionScore(opts: {
  eventId: string;
  knowledgeId: string;
  predicted_p: number;
  baseline_p: number;
  outcome: 0 | 1;
  resolution: 'confirmed' | 'retired';
  brier_model: number;
  brier_baseline: number;
  log_loss_model: number;
  skill_score_point: number;
  createdAt: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: opts.eventId,
    actor_kind: 'system',
    actor_ref: 'reconcile',
    action: PREDICTION_SCORE_ACTION,
    subject_kind: 'event',
    subject_id: `probe_result_${opts.eventId}`,
    outcome: 'success',
    payload: {
      conjecture_event_id: `conjecture_${opts.eventId}`,
      probe_result_event_id: `probe_result_${opts.eventId}`,
      knowledge_id: opts.knowledgeId,
      predicted_p: opts.predicted_p,
      baseline_p: opts.baseline_p,
      outcome: opts.outcome,
      resolution: opts.resolution,
      brier_model: opts.brier_model,
      brier_baseline: opts.brier_baseline,
      log_loss_model: opts.log_loss_model,
      skill_score_point: opts.skill_score_point,
      retrievability_at_judge: null,
    },
    caused_by_event_id: `probe_result_${opts.eventId}`,
    created_at: opts.createdAt,
    // Opt out of memory-ingestion outbox (mirrors the real reconcile writer).
    ingest_at: opts.createdAt,
  });
}

async function seedTypedState(opts: {
  id: string;
  knowledgeId: string;
  confusedWithKcId: string | null;
  lifecycle: 'open' | 'resolved';
  evidenceEventIds: string[];
}): Promise<void> {
  await testDb()
    .insert(kc_typed_state)
    .values({
      id: opts.id,
      subject_kind: 'knowledge',
      subject_id: opts.knowledgeId,
      typed_state: 'confused-with-X',
      confused_with_kc_id: opts.confusedWithKcId,
      lifecycle: opts.lifecycle,
      evidence_event_ids: opts.evidenceEventIds,
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

async function fsrsRowCount(): Promise<number> {
  const rows = await testDb().select().from(material_fsrs_state);
  return rows.length;
}

async function predictionScoreCount(): Promise<number> {
  const rows = await testDb().select().from(event).where(eq(event.action, PREDICTION_SCORE_ACTION));
  return rows.length;
}

describe('GET /api/admin/conjecture-scores (conjecture-wire #13 S4)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge();
  });

  it('renders BOTH halves — prediction_score events + confused-with-X typed_states (A4 fix)', async () => {
    const now = new Date('2026-07-04T00:00:00Z');
    await seedPredictionScore({
      eventId: 'score_1',
      knowledgeId: KC_ID,
      predicted_p: 0.3,
      baseline_p: 0.6,
      outcome: 0,
      resolution: 'confirmed',
      brier_model: 0.09,
      brier_baseline: 0.36,
      log_loss_model: 0.356,
      skill_score_point: 0.75,
      createdAt: now,
    });
    await seedTypedState({
      id: 'ts_1',
      knowledgeId: KC_ID,
      confusedWithKcId: RIVAL_KC,
      lifecycle: 'open',
      evidenceEventIds: ['probe_result_1', 'conjecture_1'],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Honest score basis declaration (single-point, NOT window mean / «accuracy»).
    expect(body.score_basis).toBe('single_point');

    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      event_id: 'score_1',
      conjecture_event_id: 'conjecture_score_1',
      knowledge_id: KC_ID,
      predicted_p: 0.3,
      baseline_p: 0.6,
      outcome: 0,
      resolution: 'confirmed',
      brier_model: 0.09,
      brier_baseline: 0.36,
      log_loss_model: 0.356,
      skill_score_point: 0.75,
      retrievability_at_judge: null,
    });

    const typed = body.typed_states as Array<Record<string, unknown>>;
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({
      id: 'ts_1',
      knowledge_id: KC_ID,
      typed_state: 'confused-with-X',
      confused_with_kc_id: RIVAL_KC,
      lifecycle: 'open',
      evidence_event_ids: ['probe_result_1', 'conjecture_1'],
    });
  });

  it('HONEST render — no «accuracy» field; canonical score names only', async () => {
    await seedPredictionScore({
      eventId: 'score_honest',
      knowledgeId: KC_ID,
      predicted_p: 0.3,
      baseline_p: 0.6,
      outcome: 0,
      resolution: 'confirmed',
      brier_model: 0.09,
      brier_baseline: 0.36,
      log_loss_model: 0.356,
      skill_score_point: 0.75,
      createdAt: new Date(),
    });

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(1);
    const row = scores[0];
    // Canonical proper-score names present.
    expect(row).toHaveProperty('brier_model');
    expect(row).toHaveProperty('brier_baseline');
    expect(row).toHaveProperty('log_loss_model');
    expect(row).toHaveProperty('skill_score_point');
    // No misleading «accuracy» field (skill_score_point is a single-point proper score,
    // not a window-calibrated accuracy). The honest basis is declared up-top.
    expect(row).not.toHaveProperty('accuracy');
    expect(body.score_basis).toBe('single_point');
  });

  it('newest-first ordering across multiple prediction_score events', async () => {
    const old = new Date('2026-07-01T00:00:00Z');
    const fresh = new Date('2026-07-04T00:00:00Z');
    await seedPredictionScore({
      eventId: 'score_old',
      knowledgeId: KC_ID,
      predicted_p: 0.3,
      baseline_p: 0.6,
      outcome: 0,
      resolution: 'confirmed',
      brier_model: 0.09,
      brier_baseline: 0.36,
      log_loss_model: 0.356,
      skill_score_point: 0.75,
      createdAt: old,
    });
    await seedPredictionScore({
      eventId: 'score_fresh',
      knowledgeId: KC_ID,
      predicted_p: 0.4,
      baseline_p: 0.6,
      outcome: 1,
      resolution: 'retired',
      brier_model: 0.16,
      brier_baseline: 0.16,
      log_loss_model: 0.511,
      skill_score_point: 0,
      createdAt: fresh,
    });

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(2);
    expect(scores[0].event_id).toBe('score_fresh');
    expect(scores[1].event_id).toBe('score_old');
  });

  it('fail-closed per-field — a corrupt prediction_score (missing/invalid load-bearing value) drops', async () => {
    // Corrupt: predicted_p is a string, not a number.
    await writeEvent(testDb(), {
      id: 'score_corrupt',
      actor_kind: 'system',
      actor_ref: 'reconcile',
      action: PREDICTION_SCORE_ACTION,
      subject_kind: 'event',
      subject_id: 'probe_corrupt',
      outcome: 'success',
      payload: {
        conjecture_event_id: 'conj',
        probe_result_event_id: 'probe_corrupt',
        knowledge_id: KC_ID,
        predicted_p: 'not-a-number',
        baseline_p: 0.6,
        outcome: 0,
        resolution: 'confirmed',
        brier_model: 0.09,
        brier_baseline: 0.36,
        log_loss_model: 0.356,
        skill_score_point: 0.75,
      },
      caused_by_event_id: 'probe_corrupt',
      created_at: new Date(),
      ingest_at: new Date(),
    });

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(0);
  });

  it('bounds both reads in the database and returns the newest rows first', async () => {
    const baseMs = new Date('2026-07-01T00:00:00.000Z').getTime();
    const count = CONJECTURE_SCORES_LIMIT + 1;
    await testDb()
      .insert(event)
      .values(
        Array.from({ length: count }, (_, index) => ({
          id: `bounded_score_${String(index).padStart(3, '0')}`,
          actor_kind: 'system',
          actor_ref: 'reconcile',
          action: PREDICTION_SCORE_ACTION,
          subject_kind: 'event',
          subject_id: `bounded_probe_${index}`,
          outcome: 'success',
          payload: {
            conjecture_event_id: `bounded_conjecture_${index}`,
            probe_result_event_id: `bounded_probe_${index}`,
            knowledge_id: KC_ID,
            predicted_p: 0.3,
            baseline_p: 0.6,
            outcome: 0,
            resolution: 'confirmed',
            brier_model: 0.09,
            brier_baseline: 0.36,
            log_loss_model: 0.356,
            skill_score_point: 0.75,
          },
          created_at: new Date(baseMs + index),
          ingest_at: new Date(baseMs + index),
        })),
      );
    await testDb()
      .insert(kc_typed_state)
      .values(
        Array.from({ length: count }, (_, index) => ({
          id: `bounded_state_${String(index).padStart(3, '0')}`,
          subject_kind: 'knowledge',
          subject_id: `bounded_kc_${index}`,
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'open',
          evidence_event_ids: [`bounded_probe_${index}`],
          updated_at: new Date(baseMs + index),
        })),
      );

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    const states = body.typed_states as Array<Record<string, unknown>>;

    expect(scores).toHaveLength(CONJECTURE_SCORES_LIMIT);
    expect(scores[0].event_id).toBe(`bounded_score_${CONJECTURE_SCORES_LIMIT}`);
    expect(scores.at(-1)?.event_id).toBe('bounded_score_001');
    expect(states).toHaveLength(CONJECTURE_SCORES_LIMIT);
    expect(states[0].id).toBe(`bounded_state_${CONJECTURE_SCORES_LIMIT}`);
    expect(states.at(-1)?.id).toBe('bounded_state_001');
  });

  it('drops malformed confused-with-X typed-state rows instead of fabricating provenance', async () => {
    await testDb()
      .insert(kc_typed_state)
      .values([
        {
          id: 'typed_invalid_lifecycle',
          subject_kind: 'knowledge',
          subject_id: KC_ID,
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'corrupt',
          evidence_event_ids: ['probe_valid'],
        },
        {
          id: 'typed_invalid_evidence',
          subject_kind: 'knowledge',
          subject_id: RIVAL_KC,
          typed_state: 'confused-with-X',
          confused_with_kc_id: KC_ID,
          lifecycle: 'open',
          evidence_event_ids: [42] as never,
        },
      ]);

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.typed_states).toEqual([]);
  });

  it('READ-ONLY — the route writes nothing (ND-5: no FSRS, no new events, no state mutation)', async () => {
    const beforeScores = await predictionScoreCount();
    const beforeFsrs = await fsrsRowCount();

    const res = await GET();
    expect(res.status).toBe(200);

    // No new events, no FSRS rows — the reader is pure projection.
    expect(await predictionScoreCount()).toBe(beforeScores);
    expect(await fsrsRowCount()).toBe(beforeFsrs);
  });

  it('empty state — both halves render as [] (no crash on zero data)', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prediction_scores).toEqual([]);
    expect(body.typed_states).toEqual([]);
    expect(body.score_basis).toBe('single_point');
  });
});
