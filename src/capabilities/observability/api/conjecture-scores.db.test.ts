// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S4 + §10 A4) — admin conjecture-scores reader test.
//
// Asserts the reader's three contracts:
//   1. BOTH halves render (A4 fix): prediction_score LOG events + kc_typed_state
//      confused-with-X rows (a directly seeded structural fixture; its producer is pending).
//   2. HONEST render: score fields are brier_model / brier_baseline / log_loss_model /
//      skill_score_point + score_basis='single_point' (NOT «accuracy», NOT a window mean).
//   3. READ-ONLY: the route writes nothing (ND-5 — no FSRS, no attempt, no state mutation).
//
// Seeds prediction_score events + kc_typed_state rows DIRECTLY (the reader is the unit
// under test; the reconcile producer is exercised in reconcile.db.test.ts). Fail-closed
// per-field rendering is asserted via a corrupt-score row that must drop (not partially render).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/public';
import { PROBE_RESOLUTION_RULE_VERSION } from '@/core/schema/conjecture';
import { type Db, type Tx, db as singletonDb } from '@/db/client';
import { event, kc_typed_state, knowledge, material_fsrs_state } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadConjectureScores } from '../public';
import { diagnosticsPublicSnapshot } from '../server/diagnostics-read-test-helpers';
import { GET } from './conjecture-scores';
import { ConjectureScoresResponseSchema } from './diagnostic-contracts';

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

async function seedPredictionScore(
  opts: {
    eventId: string;
    knowledgeId: string;
    predicted_p: number;
    baseline_p: number;
    outcome: 0 | 1;
    resolution: 'evidence_for' | 'confirmed' | 'retired';
    brier_model: number;
    brier_baseline: number;
    log_loss_model: number;
    skill_score_point: number;
    createdAt: Date;
  },
  database: Db | Tx = testDb(),
): Promise<void> {
  await writeEvent(database, {
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

async function seedTypedState(
  opts: {
    id: string;
    knowledgeId: string;
    confusedWithKcId: string | null;
    lifecycle: 'open' | 'resolved';
    evidenceEventIds: string[];
  },
  database: Db | Tx = testDb(),
): Promise<void> {
  await database
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

async function getWithPublicParity(): Promise<Response> {
  const read = await loadConjectureScores(testDb());
  expect(ConjectureScoresResponseSchema.parse(read)).toEqual(read);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.clone().text()).toBe(JSON.stringify(read));
  return response;
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
      resolution: 'evidence_for',
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

    const res = await getWithPublicParity();
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
      resolution: 'evidence_for',
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
    expect(body.diagnostics).toEqual({
      prediction_scores: { scanned_count: 1, dropped_count: 0, scan_truncated: false },
      typed_states: { scanned_count: 1, dropped_count: 0, scan_truncated: false },
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

    const res = await getWithPublicParity();
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

    const res = await getWithPublicParity();
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

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(0);
    expect(body.diagnostics).toMatchObject({
      prediction_scores: { scanned_count: 1, dropped_count: 1, scan_truncated: false },
    });
  });

  it('renders missing score metrics as null but drops corrupt numeric metrics', async () => {
    const now = new Date('2026-07-04T00:00:00Z');
    const commonPayload = {
      conjecture_event_id: 'conj',
      probe_result_event_id: 'probe',
      knowledge_id: KC_ID,
      predicted_p: 0.3,
      baseline_p: 0.6,
      outcome: 0,
      resolution: 'confirmed',
      brier_baseline: 0.36,
      log_loss_model: 0.356,
      skill_score_point: 0.75,
    } as const;

    await writeEvent(testDb(), {
      id: 'score_missing_metric',
      actor_kind: 'system',
      actor_ref: 'reconcile',
      action: PREDICTION_SCORE_ACTION,
      subject_kind: 'event',
      subject_id: 'probe_missing_metric',
      outcome: 'success',
      payload: { ...commonPayload, brier_model: null },
      created_at: now,
      ingest_at: now,
    });
    await writeEvent(testDb(), {
      id: 'score_corrupt_metric',
      actor_kind: 'system',
      actor_ref: 'reconcile',
      action: PREDICTION_SCORE_ACTION,
      subject_kind: 'event',
      subject_id: 'probe_corrupt_metric',
      outcome: 'success',
      payload: { ...commonPayload, brier_model: 'not-a-number' },
      created_at: new Date(now.getTime() + 1),
      ingest_at: now,
    });

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      event_id: 'score_missing_metric',
      brier_model: null,
      brier_baseline: 0.36,
    });
  });

  it('fail-closes corrupt typed-state lifecycle and provenance rows', async () => {
    const now = new Date('2026-07-04T00:00:00Z');
    await seedTypedState({
      id: 'ts_valid',
      knowledgeId: KC_ID,
      confusedWithKcId: RIVAL_KC,
      lifecycle: 'open',
      evidenceEventIds: ['probe_valid'],
    });
    await testDb()
      .insert(kc_typed_state)
      .values([
        {
          id: 'ts_bad_lifecycle',
          subject_kind: 'knowledge',
          subject_id: 'kn_bad_lifecycle',
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'corrupt',
          evidence_event_ids: ['probe_bad_lifecycle'],
          updated_at: now,
        },
        {
          id: 'ts_bad_provenance',
          subject_kind: 'knowledge',
          subject_id: 'kn_bad_provenance',
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'open',
          evidence_event_ids: ['probe_valid', 42] as unknown as string[],
          updated_at: now,
        },
      ]);

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    const typed = body.typed_states as Array<Record<string, unknown>>;
    expect(typed).toHaveLength(1);
    expect(typed[0]?.id).toBe('ts_valid');
  });

  it('bounds both reads to the newest 200 rows in the database', async () => {
    const base = new Date('2026-07-01T00:00:00Z');
    await testDb().transaction(async (tx) => {
      for (let i = 0; i <= 200; i += 1) {
        const createdAt = new Date(base.getTime() + i);
        await writeEvent(tx, {
          id: `score_bound_${i}`,
          actor_kind: 'system',
          actor_ref: 'reconcile',
          action: PREDICTION_SCORE_ACTION,
          subject_kind: 'event',
          subject_id: `probe_bound_${i}`,
          outcome: 'success',
          payload: {
            conjecture_event_id: `conjecture_bound_${i}`,
            probe_result_event_id: `probe_bound_${i}`,
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
          created_at: createdAt,
          ingest_at: createdAt,
        });
      }
      const corruptAt = new Date(base.getTime() + 201);
      await writeEvent(tx, {
        id: 'score_bound_corrupt_newest',
        actor_kind: 'system',
        actor_ref: 'reconcile',
        action: PREDICTION_SCORE_ACTION,
        subject_kind: 'event',
        subject_id: 'probe_bound_corrupt_newest',
        outcome: 'success',
        payload: {
          conjecture_event_id: 'conjecture_bound_corrupt_newest',
          probe_result_event_id: 'probe_bound_corrupt_newest',
          knowledge_id: KC_ID,
          predicted_p: 0.3,
          baseline_p: 0.6,
          outcome: 0,
          resolution: 'confirmed',
          brier_model: 'not-a-number',
          brier_baseline: 0.36,
          log_loss_model: 0.356,
          skill_score_point: 0.75,
        },
        created_at: corruptAt,
        ingest_at: corruptAt,
      });
    });
    await testDb()
      .insert(kc_typed_state)
      .values(
        Array.from({ length: 201 }, (_, i) => ({
          id: `ts_bound_${i}`,
          subject_kind: 'knowledge',
          subject_id: `kn_bound_${i}`,
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'open',
          evidence_event_ids: [`probe_bound_${i}`],
          updated_at: new Date(base.getTime() + i),
        })),
      );
    await testDb()
      .insert(kc_typed_state)
      .values({
        id: 'ts_bound_corrupt_newest',
        subject_kind: 'knowledge',
        subject_id: 'kn_bound_corrupt_newest',
        typed_state: 'confused-with-X',
        confused_with_kc_id: RIVAL_KC,
        lifecycle: 'corrupt',
        evidence_event_ids: ['probe_bound_corrupt_newest'],
        updated_at: new Date(base.getTime() + 201),
      });

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    const typed = body.typed_states as Array<Record<string, unknown>>;
    expect(scores).toHaveLength(200);
    expect(scores[0]?.event_id).toBe('score_bound_200');
    expect(scores.at(-1)?.event_id).toBe('score_bound_1');
    expect(scores.some((row) => row.event_id === 'score_bound_0')).toBe(false);
    expect(typed).toHaveLength(200);
    expect(typed[0]?.id).toBe('ts_bound_200');
    expect(typed.at(-1)?.id).toBe('ts_bound_1');
    expect(typed.some((row) => row.id === 'ts_bound_0')).toBe(false);
    expect(body.diagnostics).toEqual({
      prediction_scores: { scanned_count: 201, dropped_count: 1, scan_truncated: true },
      typed_states: { scanned_count: 201, dropped_count: 1, scan_truncated: true },
    });
  });

  it('does not report truncation at the exact 200-valid result boundary', async () => {
    const base = new Date('2026-07-01T00:00:00Z');
    await testDb().transaction(async (tx) => {
      for (let i = 0; i < 200; i += 1) {
        const createdAt = new Date(base.getTime() + i);
        await writeEvent(tx, {
          id: `score_exact_result_${i}`,
          actor_kind: 'system',
          actor_ref: 'reconcile',
          action: PREDICTION_SCORE_ACTION,
          subject_kind: 'event',
          subject_id: `probe_exact_result_${i}`,
          outcome: 'success',
          payload: {
            conjecture_event_id: `conjecture_exact_result_${i}`,
            probe_result_event_id: `probe_exact_result_${i}`,
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
          created_at: createdAt,
          ingest_at: createdAt,
        });
      }
    });

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prediction_scores).toHaveLength(200);
    expect(body.diagnostics).toMatchObject({
      prediction_scores: { scanned_count: 200, dropped_count: 0, scan_truncated: false },
    });
  });

  it('does not report truncation after scanning exactly 400 rows with fewer than 200 valid', async () => {
    const base = new Date('2026-07-01T00:00:00Z');
    await testDb()
      .insert(kc_typed_state)
      .values([
        ...Array.from({ length: 199 }, (_, i) => ({
          id: `ts_exact_scan_valid_${i}`,
          subject_kind: 'knowledge',
          subject_id: `kn_exact_scan_valid_${i}`,
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'open',
          evidence_event_ids: [`probe_exact_scan_valid_${i}`],
          updated_at: new Date(base.getTime() + i),
        })),
        ...Array.from({ length: 201 }, (_, offset) => {
          const i = offset + 199;
          return {
            id: `ts_exact_scan_corrupt_${i}`,
            subject_kind: 'knowledge',
            subject_id: `kn_exact_scan_corrupt_${i}`,
            typed_state: 'confused-with-X',
            confused_with_kc_id: RIVAL_KC,
            lifecycle: 'corrupt',
            evidence_event_ids: [`probe_exact_scan_corrupt_${i}`],
            updated_at: new Date(base.getTime() + i),
          };
        }),
      ]);

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.typed_states).toHaveLength(199);
    expect(body.diagnostics).toMatchObject({
      typed_states: { scanned_count: 400, dropped_count: 201, scan_truncated: false },
    });
  });

  it('hard-stops each database scan after 400 raw rows', async () => {
    const base = new Date('2026-07-01T00:00:00Z');
    await testDb().transaction(async (tx) => {
      for (let i = 0; i < 200; i += 1) {
        const createdAt = new Date(base.getTime() + i);
        await writeEvent(tx, {
          id: `score_scan_valid_${i}`,
          actor_kind: 'system',
          actor_ref: 'reconcile',
          action: PREDICTION_SCORE_ACTION,
          subject_kind: 'event',
          subject_id: `probe_scan_valid_${i}`,
          outcome: 'success',
          payload: {
            conjecture_event_id: `conjecture_scan_valid_${i}`,
            probe_result_event_id: `probe_scan_valid_${i}`,
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
          created_at: createdAt,
          ingest_at: createdAt,
        });
      }
      for (let i = 200; i <= 400; i += 1) {
        const createdAt = new Date(base.getTime() + i);
        await writeEvent(tx, {
          id: `score_scan_corrupt_${i}`,
          actor_kind: 'system',
          actor_ref: 'reconcile',
          action: PREDICTION_SCORE_ACTION,
          subject_kind: 'event',
          subject_id: `probe_scan_corrupt_${i}`,
          outcome: 'success',
          payload: {
            conjecture_event_id: `conjecture_scan_corrupt_${i}`,
            probe_result_event_id: `probe_scan_corrupt_${i}`,
            knowledge_id: KC_ID,
            predicted_p: 0.3,
            baseline_p: 0.6,
            outcome: 0,
            resolution: 'confirmed',
            brier_model: 'not-a-number',
            brier_baseline: 0.36,
            log_loss_model: 0.356,
            skill_score_point: 0.75,
          },
          created_at: createdAt,
          ingest_at: createdAt,
        });
      }
    });

    await testDb()
      .insert(kc_typed_state)
      .values([
        ...Array.from({ length: 200 }, (_, i) => ({
          id: `ts_scan_valid_${i}`,
          subject_kind: 'knowledge',
          subject_id: `kn_scan_valid_${i}`,
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'open',
          evidence_event_ids: [`probe_scan_valid_${i}`],
          updated_at: new Date(base.getTime() + i),
        })),
        ...Array.from({ length: 201 }, (_, offset) => {
          const i = offset + 200;
          return {
            id: `ts_scan_corrupt_${i}`,
            subject_kind: 'knowledge',
            subject_id: `kn_scan_corrupt_${i}`,
            typed_state: 'confused-with-X',
            confused_with_kc_id: RIVAL_KC,
            lifecycle: 'corrupt',
            evidence_event_ids: [`probe_scan_corrupt_${i}`],
            updated_at: new Date(base.getTime() + i),
          };
        }),
      ]);

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    const scores = body.prediction_scores as Array<Record<string, unknown>>;
    const typed = body.typed_states as Array<Record<string, unknown>>;
    // The newest 400 raw rows contain 201 corrupt + 199 valid rows. The one oldest valid
    // row sits just beyond the hard cap; an unbounded query would incorrectly return 200.
    expect(scores).toHaveLength(199);
    expect(scores.some((row) => row.event_id === 'score_scan_valid_0')).toBe(false);
    expect(typed).toHaveLength(199);
    expect(typed.some((row) => row.id === 'ts_scan_valid_0')).toBe(false);
    expect(body.diagnostics).toEqual({
      prediction_scores: { scanned_count: 400, dropped_count: 201, scan_truncated: true },
      typed_states: { scanned_count: 400, dropped_count: 201, scan_truncated: true },
    });
  });

  it('filters unrelated subject kinds before applying the typed-state scan budget', async () => {
    const base = new Date('2026-07-01T00:00:00Z');
    await testDb()
      .insert(kc_typed_state)
      .values([
        {
          id: 'ts_kind_valid',
          subject_kind: 'knowledge',
          subject_id: 'kn_kind_valid',
          typed_state: 'confused-with-X',
          confused_with_kc_id: RIVAL_KC,
          lifecycle: 'open',
          evidence_event_ids: ['probe_kind_valid'],
          updated_at: base,
        },
        ...Array.from({ length: 400 }, (_, offset) => {
          const i = offset + 1;
          return {
            id: `ts_kind_unrelated_${i}`,
            subject_kind: 'artifact',
            subject_id: `art_kind_unrelated_${i}`,
            typed_state: 'confused-with-X',
            confused_with_kc_id: RIVAL_KC,
            lifecycle: 'open',
            evidence_event_ids: [`probe_kind_unrelated_${i}`],
            updated_at: new Date(base.getTime() + i),
          };
        }),
      ]);

    const res = await getWithPublicParity();
    const body = (await res.json()) as Record<string, unknown>;
    const typed = body.typed_states as Array<Record<string, unknown>>;
    expect(typed).toHaveLength(1);
    expect(typed[0]?.id).toBe('ts_kind_valid');
    expect(body.diagnostics).toMatchObject({
      typed_states: { scanned_count: 1, dropped_count: 0, scan_truncated: false },
    });
  });

  it('READ-ONLY — the route writes nothing (ND-5: no FSRS, no new events, no state mutation)', async () => {
    const beforeScores = await predictionScoreCount();
    const beforeFsrs = await fsrsRowCount();

    const res = await getWithPublicParity();
    expect(res.status).toBe(200);

    // No new events, no FSRS rows — the reader is pure projection.
    expect(await predictionScoreCount()).toBe(beforeScores);
    expect(await fsrsRowCount()).toBe(beforeFsrs);
  });

  it('public reader sees nonzero legacy scores and typed states only inside the supplied Tx, writes nothing and rolls back', async () => {
    const baseline = await diagnosticsPublicSnapshot(testDb());
    const rollback = new Error('intentional conjecture rollback');
    await expect(
      testDb().transaction(async (tx) => {
        await seedPredictionScore(
          {
            eventId: 'score_tx_missing_source',
            knowledgeId: KC_ID,
            predicted_p: 0.3,
            baseline_p: 0.6,
            outcome: 0,
            resolution: 'confirmed',
            brier_model: 0.09,
            brier_baseline: 0.36,
            log_loss_model: 0.356,
            skill_score_point: 0.75,
            createdAt: new Date('2026-10-08T23:59:59.123Z'),
          },
          tx,
        );
        await seedTypedState(
          {
            id: 'typed_tx',
            knowledgeId: KC_ID,
            confusedWithKcId: RIVAL_KC,
            lifecycle: 'resolved',
            evidenceEventIds: [
              'probe_result_score_tx_missing_source',
              'conjecture_score_tx_missing_source',
              '原始复杂条件'.repeat(100),
            ],
          },
          tx,
        );
        const at = new Date('2026-10-08T23:59:59.123Z');
        for (const suffix of ['corrected', 'inactive']) {
          await seedPredictionScore(
            {
              eventId: `score_tx_${suffix}`,
              knowledgeId: KC_ID,
              predicted_p: 0.3,
              baseline_p: 0.6,
              outcome: 0,
              resolution: 'confirmed',
              brier_model: 0.09,
              brier_baseline: 0.36,
              log_loss_model: 0.356,
              skill_score_point: 0.75,
              createdAt: at,
            },
            tx,
          );
          await tx.insert(event).values({
            id: `probe_result_score_tx_${suffix}`,
            actor_kind: 'system',
            actor_ref: 'probe_answer',
            action: 'experimental:probe_result',
            subject_kind: 'question',
            subject_id: `q_tx_${suffix}`,
            caused_by_event_id: `conjecture_score_tx_${suffix}`,
            outcome: 'success',
            payload: {
              conjecture_event_id: `conjecture_score_tx_${suffix}`,
              outcome: 0,
              resolution: suffix === 'inactive' ? 'confirmed' : 'evidence_for',
              resolution_rule_version: PROBE_RESOLUTION_RULE_VERSION,
              independent_probe_question_ids: [`q_tx_${suffix}`],
            },
            created_at: at,
            ingest_at: at,
          });
        }
        await writeEvent(tx, {
          id: 'correct_tx_probe',
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: 'probe_result_score_tx_corrected',
          outcome: 'success',
          payload: {
            correction_kind: 'mark_wrong',
            reason_md: '原始证据被撤回，不能用于评分'.repeat(100),
            affected_refs: [{ kind: 'open_inquiry', id: 'probe_result_score_tx_corrected' }],
          },
          created_at: new Date(at.getTime() + 1),
          ingest_at: at,
        });
        await tx.insert(event).values({
          id: 'score_tx_corrupt',
          actor_kind: 'system',
          actor_ref: 'reconcile',
          action: PREDICTION_SCORE_ACTION,
          subject_kind: 'event',
          subject_id: 'probe_tx_corrupt',
          outcome: 'success',
          payload: {
            conjecture_event_id: 'conjecture_tx_corrupt',
            probe_result_event_id: 'probe_tx_corrupt',
            knowledge_id: KC_ID,
            predicted_p: 'invalid',
            baseline_p: 0.6,
            outcome: 0,
            resolution: 'confirmed',
          },
          created_at: at,
          ingest_at: at,
        });
        const statuses = await getEffectiveProbeResultStatuses(tx, [
          'probe_result_score_tx_missing_source',
          'probe_result_score_tx_corrected',
          'probe_result_score_tx_inactive',
        ]);
        expect(statuses.get('probe_result_score_tx_missing_source')).toBe('missing');
        expect(statuses.get('probe_result_score_tx_corrected')).toBe('corrected');
        expect(statuses.get('probe_result_score_tx_inactive')).toBe('dependency_inactive');
        const before = await diagnosticsPublicSnapshot(tx);
        expect(before).not.toEqual(baseline);
        const read = await loadConjectureScores(tx);
        expect(ConjectureScoresResponseSchema.parse(read)).toEqual(read);
        // Missing source status remains displayable for historical score rows.
        expect(read.prediction_scores.map((r) => r.event_id)).toEqual(['score_tx_missing_source']);
        expect(read.typed_states).toHaveLength(1);
        expect(read.typed_states[0].evidence_event_ids).toHaveLength(3);
        expect(read.diagnostics).toEqual({
          prediction_scores: { scanned_count: 4, dropped_count: 3, scan_truncated: false },
          typed_states: { scanned_count: 1, dropped_count: 0, scan_truncated: false },
        });
        for (const database of [singletonDb, testDb()]) {
          const outside = await loadConjectureScores(database);
          expect(outside.prediction_scores).toEqual([]);
          expect(outside.typed_states).toEqual([]);
        }
        expect(await diagnosticsPublicSnapshot(singletonDb)).toEqual(baseline);
        expect(await diagnosticsPublicSnapshot(tx)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const after = await loadConjectureScores(testDb());
    expect(after.prediction_scores).toEqual([]);
    expect(after.typed_states).toEqual([]);
    expect(await diagnosticsPublicSnapshot(testDb())).toEqual(baseline);
  });

  it('empty state — both halves render as [] (no crash on zero data)', async () => {
    const res = await getWithPublicParity();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prediction_scores).toEqual([]);
    expect(body.typed_states).toEqual([]);
    expect(body.score_basis).toBe('single_point');
    expect(body.diagnostics).toEqual({
      prediction_scores: { scanned_count: 0, dropped_count: 0, scan_truncated: false },
      typed_states: { scanned_count: 0, dropped_count: 0, scan_truncated: false },
    });
  });
});
