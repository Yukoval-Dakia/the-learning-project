import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { job_events, learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../tests/helpers/db';

const cutoff = new Date('2026-10-09T00:00:00Z');
async function candidate(id: string) {
  const [row] = await testDb()
    .select({
      sessionId: learning_session.id,
      selectedStartedAt: sql<string>`${learning_session.started_at}::text`,
      selectedVersion: learning_session.version,
    })
    .from(learning_session)
    .where(eq(learning_session.id, id));
  return row;
}
async function start(at = '2026-10-08 16:00:00.123456+00') {
  const { sessionId } = await Review.startReviewSession(testDb());
  await testDb().execute(
    sql`update learning_session set started_at = ${at}::timestamptz where id = ${sessionId}`,
  );
  return sessionId;
}
async function events(id: string) {
  return testDb()
    .select()
    .from(job_events)
    .where(and(eq(job_events.business_id, id), eq(job_events.event_type, 'review.abandoned')));
}
beforeEach(resetDb);
describe('guarded orphan Review transition', () => {
  it('keeps microseconds, strict cutoff, and the original event/version writer', async () => {
    const old = await start('2026-10-08 23:59:59.999999+00');
    const boundary = await start('2026-10-09 00:00:00+00');
    const later = await start('2026-10-09 00:00:00.000001+00');
    const selected = await candidate(old);
    expect(selected.selectedStartedAt).toContain('999999');
    expect(
      await testDb().transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff }),
      ),
    ).toEqual({ kind: 'abandoned', fromVersion: 0, toVersion: 1 });
    for (const id of [boundary, later])
      expect(
        await testDb().transaction(async (tx) =>
          Review.abandonOrphanReviewSession(tx, { candidate: await candidate(id), cutoff }),
        ),
      ).toEqual({ kind: 'skipped', reason: 'not-old' });
    expect(await events(old)).toHaveLength(1);
    expect(await events(boundary)).toHaveLength(0);
  });
  it('rejects a different incarnation one microsecond away within the same JavaScript millisecond', async () => {
    const id = await start('2026-10-08 16:00:00.123456+00');
    const selected = await candidate(id);
    await testDb().execute(
      sql`update learning_session set started_at = started_at + interval '1 microsecond' where id = ${id}`,
    );
    const current = await candidate(id);
    expect(new Date(current.selectedStartedAt).getTime()).toBe(
      new Date(selected.selectedStartedAt).getTime(),
    );
    expect(
      await testDb().transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'reopened' });
    expect(await events(id)).toHaveLength(0);
  });

  it('allows pause/resume version changes but rejects close/reopen of the selected incarnation', async () => {
    const id = await start();
    const selected = await candidate(id);
    await Review.pauseReviewSession(testDb(), id);
    await Review.resumeReviewSession(testDb(), id);
    expect(
      await testDb().transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff }),
      ),
    ).toEqual({ kind: 'abandoned', fromVersion: 2, toVersion: 3 });
    await Review.reopenAbandonedReviewSession(testDb(), id);
    expect(
      await testDb().transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'reopened' });
    expect(await events(id)).toHaveLength(1);
  });
  it('rolls back the existing writer and event when the caller transaction fails', async () => {
    const id = await start();
    const selected = await candidate(id);
    await expect(
      testDb().transaction(async (tx) => {
        await Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff });
        throw new Error('outer receipt failed');
      }),
    ).rejects.toThrow('outer receipt failed');
    expect(await events(id)).toHaveLength(0);
    const [row] = await testDb().select().from(learning_session).where(eq(learning_session.id, id));
    expect(row).toMatchObject({ status: 'started', version: 0 });
  });
  it('waits for completion to win the row lock and skips terminal/missing/other types', async () => {
    const id = await start();
    const selected = await candidate(id);
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = testDb().transaction(async (tx) => {
      await Review.transitionReviewSession(tx, id, 'completed');
      acquired();
      await wait;
    });
    await held;
    const sweep = testDb().transaction((tx) =>
      Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff }),
    );
    release();
    await complete;
    expect(await sweep).toEqual({ kind: 'skipped', reason: 'terminal' });
    await testDb().delete(learning_session).where(eq(learning_session.id, id));
    expect(
      await testDb().transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: selected, cutoff }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'missing' });
    const other = await start();
    const otherSelected = await candidate(other);
    await testDb()
      .update(learning_session)
      .set({ type: 'conversation' })
      .where(eq(learning_session.id, other));
    expect(
      await testDb().transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: otherSelected, cutoff }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'missing' });
  });
});
