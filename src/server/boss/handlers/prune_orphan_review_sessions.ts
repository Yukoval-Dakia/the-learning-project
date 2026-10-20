// The page beacon covers a normal close. This helper covers a killed browser, a dropped beacon,
// and a pause the user never resumed. Paused uses the same 6h cutoff as started.
// The mounted handler calls runReviewOrphanTick and does not use the catch below.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { runReviewOrphanTick } from '@/server/durable/review-orphan-family';
import { Review } from '@/server/session';

const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;

export async function runPruneOrphanReviewSessions(db: Db): Promise<{ abandoned: number }> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  const rows = await db
    .select({
      sessionId: learning_session.id,
      selectedStartedAt: sql<string>`${learning_session.started_at}::text`,
      selectedVersion: learning_session.version,
    })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'review'),
        inArray(learning_session.status, ['started', 'paused']),
        lt(learning_session.started_at, cutoff),
      ),
    );

  let abandoned = 0;
  for (const r of rows) {
    try {
      const result = await db.transaction((tx) =>
        Review.abandonOrphanReviewSession(tx, { candidate: r, cutoff }),
      );
      if (result.kind === 'abandoned') abandoned += 1;
    } catch (err) {
      // Any error is skipped in this helper. The mounted cron does not come through here.
      console.warn(`[prune_orphan_review_sessions] skip ${r.sessionId}:`, String(err));
    }
  }
  return { abandoned };
}

export function buildPruneOrphanReviewSessionsHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const result = await runReviewOrphanTick(db, { kind: 'pg-boss', jobId: job.id });
      console.log('[prune_orphan_review_sessions] result', result);
    }
  };
}
