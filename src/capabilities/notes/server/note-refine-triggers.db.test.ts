// ADR-0040 决定2 — mastery-progress-signal (p(L) delta 埋点) DB tests.
//
// Covers the READ + EMIT helper (mastery-progress-signal.ts):
//   - readMasteryProgress reads the REAL Δθ̂/p(L) from mastery_state
//   - emitMasteryProgressSignal emits an `experimental:mastery_progress` event
//     carrying that delta
//   - RED LINE (ADR-0035): the emit path NEVER writes mastery_state (read-only).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MASTERY_PROGRESS_ACTION,
  emitMasteryProgressSignal,
  readMasteryProgress,
} from '@/capabilities/notes/server/mastery-progress-signal';
import { event, mastery_state } from '@/db/schema';
import { upsertMasteryState } from '@/server/mastery/state';
import { resetDb, testDb } from '../../../../tests/helpers/db';

describe('mastery-progress-signal (ADR-0040 决定2 p(L) delta 埋点)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedMasteryRow(
    subjectId: string,
    overrides: { theta_hat?: number; last_theta_delta?: number | null } = {},
  ) {
    const db = testDb();
    await upsertMasteryState(db, {
      subject_id: subjectId,
      theta_hat: overrides.theta_hat ?? 0.42,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date('2026-06-20T10:00:00.000Z'),
      last_theta_delta: overrides.last_theta_delta ?? 0.31,
    });
  }

  it('readMasteryProgress reads the real Δθ̂ + p(L) from mastery_state', async () => {
    await seedMasteryRow('k_read', { theta_hat: 0.5, last_theta_delta: 0.27 });

    const readings = await readMasteryProgress(testDb(), ['k_read']);
    expect(readings).toHaveLength(1);
    expect(readings[0].knowledge_id).toBe('k_read');
    // The real per-attempt Δθ̂ from mastery_state.last_theta_delta.
    expect(readings[0].theta_delta).toBeCloseTo(0.27, 5);
    expect(readings[0].theta_hat).toBeCloseTo(0.5, 5);
    // p(L) point estimate is a real 0..1 projection (difficulty-aware PFA).
    expect(readings[0].p_learned).not.toBeNull();
    expect(readings[0].p_learned as number).toBeGreaterThan(0);
    expect(readings[0].p_learned as number).toBeLessThanOrEqual(1);
  });

  it('emits an experimental:mastery_progress event carrying the delta', async () => {
    await seedMasteryRow('k_emit', { theta_hat: 0.6, last_theta_delta: 0.33 });

    const emitted = await emitMasteryProgressSignal({
      db: testDb(),
      knowledgeIds: ['k_emit'],
      questionId: 'q_emit',
      attemptEventId: 'evt_attempt_emit',
    });
    expect(emitted).toHaveLength(1);

    const rows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, MASTERY_PROGRESS_ACTION), eq(event.subject_id, 'k_emit')));
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev.subject_kind).toBe('knowledge');
    expect(ev.actor_kind).toBe('system');
    expect(ev.actor_ref).toBe('mastery_progress_signal');
    // 不带 success/failure 判分语义——纯观测读数。
    expect(ev.outcome).toBeNull();
    expect(ev.caused_by_event_id).toBe('evt_attempt_emit');
    const payload = ev.payload as Record<string, unknown>;
    // The emitted event CARRIES the real p(L) delta — the埋点 core assertion.
    expect(payload.theta_delta).toBeCloseTo(0.33, 5);
    expect(payload.theta_hat).toBeCloseTo(0.6, 5);
    expect(payload.p_learned).not.toBeNull();
    expect(payload.question_id).toBe('q_emit');
    expect(payload.attempt_event_id).toBe('evt_attempt_emit');
    // PHASE-DEFERRED marker — telemetry window, threshold not yet chosen.
    expect(payload.threshold_deferred).toBe(true);
  });

  // RED LINE (ADR-0035): emitting the signal must NOT mutate mastery_state. The
  // helper is a read-only side channel — it must never feed θ̂/p(L)/FSRS.
  it('does NOT write mastery_state (read-only red line)', async () => {
    await seedMasteryRow('k_noawrite', { theta_hat: 0.7, last_theta_delta: 0.2 });

    const before = await testDb()
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_noawrite'));
    expect(before).toHaveLength(1);
    const beforeRow = { ...before[0] };

    await emitMasteryProgressSignal({
      db: testDb(),
      knowledgeIds: ['k_noawrite'],
      attemptEventId: 'evt_noawrite',
    });

    const after = await testDb()
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_noawrite'));
    expect(after).toHaveLength(1);
    // theta_hat / counts / delta / updated_at all UNCHANGED — no write occurred.
    expect(after[0].theta_hat).toBe(beforeRow.theta_hat);
    expect(after[0].last_theta_delta).toBe(beforeRow.last_theta_delta);
    expect(after[0].success_count).toBe(beforeRow.success_count);
    expect(after[0].evidence_count).toBe(beforeRow.evidence_count);
    expect(after[0].updated_at.getTime()).toBe(beforeRow.updated_at.getTime());
  });

  it('cold-start KC (no mastery_state row) still emits with null delta', async () => {
    const emitted = await emitMasteryProgressSignal({
      db: testDb(),
      knowledgeIds: ['k_cold'],
      attemptEventId: 'evt_cold',
    });
    expect(emitted).toHaveLength(1);

    const rows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, MASTERY_PROGRESS_ACTION), eq(event.subject_id, 'k_cold')));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    // No row → null delta is a valid "first attempt" reading (still useful telemetry).
    expect(payload.theta_delta).toBeNull();
    expect(payload.p_learned).toBeNull();
  });
});
