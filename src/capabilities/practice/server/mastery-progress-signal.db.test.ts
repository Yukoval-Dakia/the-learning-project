// ADR-0040 决定2 — mastery-progress-signal (p(L) delta 埋点) DB tests.
//
// Covers the READ + EMIT helper (mastery-progress-signal.ts):
//   - readMasteryProgress reads the REAL Δθ̂/p(L) from mastery_state
//   - emitMasteryProgressSignal emits an `experimental:mastery_progress` event
//     carrying that delta
//   - RED LINE (ADR-0035): the emit path NEVER writes mastery_state (read-only).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enqueueNoteRefineTrigger } from '@/capabilities/notes/public';
import {
  MASTERY_PROGRESS_ACTION,
  emitMasteryProgressSignal,
} from '@/capabilities/practice/server/mastery-progress-signal';
import { event } from '@/db/schema';
import { upsertMasteryState } from '@/server/mastery/state';
import { resetDb, testDb } from '../../../../tests/helpers/db';

describe('note refine rolling debounce', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('waits behind a failing same-key send, then enqueues without dropping the trigger', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstSend = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let firstSendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    const bossSend = vi
      .fn()
      .mockImplementationOnce(() => {
        firstSendStarted();
        return firstSend;
      })
      .mockResolvedValueOnce('job_second');

    const first = enqueueNoteRefineTrigger({
      db: testDb(),
      artifactId: 'art_concurrent',
      kind: 'mark_wrong',
      bossSend,
    });
    await started;
    const second = enqueueNoteRefineTrigger({
      db: testDb(),
      artifactId: 'art_concurrent',
      kind: 'mark_wrong',
      bossSend,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(bossSend).toHaveBeenCalledTimes(1);

    rejectFirst(new Error('boss unavailable'));
    await expect(first).resolves.toMatchObject({ status: 'failed', error: 'boss unavailable' });
    await expect(second).resolves.toMatchObject({ status: 'enqueued' });
    expect(bossSend).toHaveBeenCalledTimes(2);
  });
});

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

  it('publishes all mastery siblings atomically or none', async () => {
    await seedMasteryRow('k_ok1', { theta_hat: 0.5, last_theta_delta: 0.21 });
    await seedMasteryRow('k_boom', { theta_hat: 0.6, last_theta_delta: 0.22 });

    const failed: string[] = [];
    const emitted = await emitMasteryProgressSignal({
      db: testDb(),
      knowledgeIds: ['k_ok1', 'k_boom'],
      attemptEventId: 'evt_atomic',
      writeEventsFn: async () => {
        throw new Error('simulated atomic batch failure');
      },
      onEmitFailure: (id) => failed.push(id),
    });

    expect(emitted).toEqual([]);
    expect(failed).toEqual(['k_ok1', 'k_boom']);
    const rows = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, MASTERY_PROGRESS_ACTION));
    expect(rows).toEqual([]);
  });
});
