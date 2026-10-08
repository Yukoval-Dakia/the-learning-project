import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { learning_session } from '@/db/schema';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  buildPruneOrphanReviewSessionsHandler,
  runPruneOrphanReviewSessions,
} from './prune_orphan_review_sessions';

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
    await testDb().execute(
      sql`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick`,
    );
    await testDb().execute(
      sql`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null`,
    );
  });

  afterEach(async () => {
    await testDb().execute(
      sql`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick`,
    );
  });

  it('the production adapter retains the actual job identity across redelivery and reopen', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await ageSession(sessionId, 7 * 3600000);
    const handler = buildPruneOrphanReviewSessionsHandler(db);
    const job = {
      id: randomUUID(),
      name: 'prune_orphan_review_sessions',
      data: {},
      expireInSeconds: 3600,
      heartbeatSeconds: null,
      retryCount: 0,
      signal: new AbortController().signal,
    };
    await handler([job]);
    const [saved] = await db.execute(sql`select tick_id, provenance from review_orphan_tick`);
    expect(saved).toMatchObject({
      tick_id: `legacy:${job.id}`,
      provenance: 'legacy-first-admission',
    });
    await Review.reopenAbandonedReviewSession(db, sessionId);
    await ageSession(sessionId, 7 * 3600000);
    await handler([{ ...job, retryCount: 1 }]);
    const [row] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(row).toMatchObject({ status: 'started', version: 2 });
    const [count] = await db.execute(
      sql`select count(*)::int as n from job_events where business_id = ${sessionId} and event_type = 'review.abandoned'`,
    );
    expect(count.n).toBe(1);
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
});
