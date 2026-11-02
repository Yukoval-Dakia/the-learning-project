import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Review from '@/capabilities/practice/session/server/review-session-lifecycle';
import {
  job_events,
  learning_session,
  review_orphan_receipt,
  review_orphan_tick,
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { inspectReviewOrphanOutcome, runReviewOrphanTick } from './review-orphan-family';

const at = new Date('2026-10-09T00:00:00Z');
const native = (id = randomUUID()) => ({ kind: 'dbos', workflowId: id, scheduledAt: at }) as const;
async function start(id?: string, timestamp = '2026-10-08 17:59:59.999999+00') {
  const { sessionId } = await Review.startReviewSession(testDb());
  await testDb().execute(
    sql`update learning_session set id = ${id ?? sessionId}, started_at = ${timestamp}::timestamptz where id = ${sessionId}`,
  );
  return id ?? sessionId;
}
async function effects(id: string) {
  return testDb()
    .select()
    .from(job_events)
    .where(and(eq(job_events.business_id, id), eq(job_events.event_type, 'review.abandoned')));
}
async function resetFamily() {
  await testDb().execute(
    sql`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick`,
  );
  await testDb().execute(
    sql`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null, phase_changed_at = clock_timestamp()`,
  );
}
beforeEach(async () => {
  await resetDb();
  await resetFamily();
  await testDb().execute(sql`update review_orphan_control set phase = 'dbos'`);
});
afterEach(resetFamily);

describe('immutable review orphan ticks and row receipts', () => {
  it('serializes duplicate executors and overlapping ticks without duplicate transition effects', async () => {
    const id = await start();
    const input = native();
    const duplicates = await Promise.all([
      runReviewOrphanTick(testDb(), input),
      runReviewOrphanTick(testDb(), input),
    ]);
    expect(duplicates[0]).toEqual(duplicates[1]);
    expect(await effects(id)).toHaveLength(1);
    const second = await start();
    let selected = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const boundary = async (event: { kind: string }) => {
      if (event.kind === 'selection-committed') {
        if (++selected === 2) release();
        await barrier;
      }
    };
    const results = await Promise.all([
      runReviewOrphanTick(testDb(), native(), boundary),
      runReviewOrphanTick(testDb(), native(), boundary),
    ]);
    expect(results.map((r) => r.abandoned).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.skipped).sort()).toEqual([0, 1]);
    expect(await effects(second)).toHaveLength(1);
  });

  it('rejects mutation/deletion of execution evidence without cascading session deletion', async () => {
    const id = await start();
    const input = native();
    await runReviewOrphanTick(testDb(), input);
    await expect(testDb().delete(review_orphan_receipt)).rejects.toThrow();
    await expect(testDb().update(review_orphan_tick).set({ candidates: [] })).rejects.toThrow();
    await testDb().delete(learning_session).where(eq(learning_session.id, id));
    expect(
      await inspectReviewOrphanOutcome(testDb(), { tickId: input.workflowId, sessionId: id }),
    ).toMatchObject({ kind: 'committed' });
  });
});
