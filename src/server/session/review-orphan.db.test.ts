import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { learning_session } from '@/db/schema';
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
beforeEach(resetDb);
describe('guarded orphan Review transition', () => {
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
