// The page beacon covers a normal close. The legacy pg-boss backend sweeps a killed browser,
// a dropped beacon and a pause never resumed, one frozen tick per job.

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { runReviewOrphanTick } from '@/server/durable/review-orphan-family';

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
