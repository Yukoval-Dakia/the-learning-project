import { learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runPruneOrphanReviewSessions } from './prune_orphan_review_sessions';

async function ageSession(sessionId: string, ageMs: number) {
  const db = testDb();
  const newStartedAt = new Date(Date.now() - ageMs);
  await db
    .update(learning_session)
    .set({ started_at: newStartedAt })
    .where(eq(learning_session.id, sessionId));
}

describe('runPruneOrphanReviewSessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('abandons review sessions in started state older than 6h', async () => {
    const db = testDb();
    const { sessionId: old1 } = await Review.startReviewSession(db);
    const { sessionId: old2 } = await Review.startReviewSession(db);
    const { sessionId: fresh } = await Review.startReviewSession(db);
    await ageSession(old1, 7 * 60 * 60 * 1000);
    await ageSession(old2, 12 * 60 * 60 * 1000);

    const result = await runPruneOrphanReviewSessions(db);
    expect(result.abandoned).toBe(2);

    const rows = await db.select().from(learning_session);
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(old1)).toBe('abandoned');
    expect(byId.get(old2)).toBe('abandoned');
    expect(byId.get(fresh)).toBe('started');
  });

  it('does not touch sessions already in completed/abandoned state', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await Review.completeReviewSession(db, sessionId);
    await ageSession(sessionId, 24 * 60 * 60 * 1000);

    const result = await runPruneOrphanReviewSessions(db);
    expect(result.abandoned).toBe(0);

    const rows = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
  });

  it('returns abandoned=0 when no orphans', async () => {
    const db = testDb();
    const result = await runPruneOrphanReviewSessions(db);
    expect(result.abandoned).toBe(0);
  });

  // YUK-57: paused sessions older than 6h are abandoned too
  it('abandons review sessions in paused state older than 6h', async () => {
    const db = testDb();
    const { sessionId: pausedOld } = await Review.startReviewSession(db);
    await Review.pauseReviewSession(db, pausedOld);
    await ageSession(pausedOld, 7 * 60 * 60 * 1000);

    const { sessionId: pausedFresh } = await Review.startReviewSession(db);
    await Review.pauseReviewSession(db, pausedFresh);

    const result = await runPruneOrphanReviewSessions(db);
    expect(result.abandoned).toBe(1);

    const rows = await db.select().from(learning_session);
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(pausedOld)).toBe('abandoned');
    expect(byId.get(pausedFresh)).toBe('paused');
  });

  // suppress unused-import in case sql gets dropped later
  void sql;
});
