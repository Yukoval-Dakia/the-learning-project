// pg-boss worker for learner-profile refresh intents. Drains pending intents
// serially under learning-state lock G (kernel/learner-profile/refresh), so a
// settlement that has just committed sees its profile rows rebuilt seconds
// later. The read-only getter covers the gap meanwhile with its same-snapshot
// fallback, so a stale row never reads as current.
//
// Wake latency: the minute-floor cron fallback plus the queue's notify poll
// interval keep a committed intent from waiting longer than a few seconds.

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { drainLearnerProfileRefresh } from '@/kernel/learner-profile/refresh';

export const LEARNER_PROFILE_REFRESH_QUEUE = 'learner_profile_refresh';

export function buildLearnerProfileRefreshHandler(
  db: Db,
): (jobs: Job<unknown>[]) => Promise<unknown> {
  return async (jobs) => {
    void jobs;
    return drainLearnerProfileRefresh(db);
  };
}
