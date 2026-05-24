// ADR-0013 — abandon review sessions left in started/paused for >6h.
// YUK-57: extended to scan paused too. A paused session is still "live" from
// the user's POV but we apply the same 6h cutoff as started — past 6h it's
// effectively abandoned regardless of which state it's stuck in.
//
// /review page sendBeacon close handles 99% of normal exits; this cron catches:
//   - browser hard-killed (no pagehide fired)
//   - sendBeacon dropped (network down / extension blocked)
//   - dev hot-reload abandoning a session without closing
//   - YUK-57: user paused then never came back
//
// Selection: type='review' AND status IN ('started','paused') AND started_at < now() - 6h.
// Action: abandon via Review.abandonReviewSession (single-owner transition).

import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { Review } from '@/server/session';

const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;

export async function runPruneOrphanReviewSessions(db: Db): Promise<{ abandoned: number }> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  const rows = await db
    .select({ id: learning_session.id })
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
      await Review.abandonReviewSession(db, r.id);
      abandoned += 1;
    } catch (err) {
      // Lost-race: another caller (sendBeacon end route) abandoned/completed it
      // between our SELECT and abandon. Skip — terminal states are fine.
      console.warn(`[prune_orphan_review_sessions] skip ${r.id}:`, (err as Error).message);
    }
  }
  return { abandoned };
}

export function buildPruneOrphanReviewSessionsHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runPruneOrphanReviewSessions(db);
    console.log('[prune_orphan_review_sessions] result', result);
  };
}
