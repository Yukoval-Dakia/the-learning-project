// Wave 5 / T-D6/B — coach_weekly pg-boss handler.
//
// Sunday weekly variant of coach_daily. Re-uses runCoach() but runs with
// runKind='weekly' to set the weekly_reflection slot on TodayPlan.

import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { type CoachRunDeps, runCoach } from './coach_daily';

export function buildCoachWeeklyHandler(
  db: Db,
  deps: CoachRunDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runCoach(db, 'weekly', deps);
    console.log('[coach_weekly] result', result);
  };
}
