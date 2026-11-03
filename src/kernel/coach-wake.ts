// The coach_daily queue contract and its on-return obligation. Agency mounts the
// handler; Practice's learner_return_wake enqueues through here, so the queue name,
// singleton key and window cannot drift between the mount and the producer.

import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { loadLastLearnerEventAt } from '@/kernel/read-models/learner-activity';

export const COACH_DAILY_QUEUE = 'coach_daily';

// Each run is one paid CoachTask. The nightly DAG ran it at most once a night;
// pg-boss keeps one job per key per 24h slot, so the on-return wake never runs
// more often than that.
const COACH_WAKE_WINDOW_SECONDS = 24 * 60 * 60;
// Written by the agency scan owner at the start of every coach run, success or not,
// so a failed run also counts as this window's attempt.
const COACH_TRIGGER_ACTION = 'experimental:trigger_coach_scan';

/**
 * Enqueue coach_daily when its plan is stale: no coach run in the last window and
 * derivation-allowed learning activity since the last one. Returns whether it sent.
 */
export async function enqueueCoachIfDue(
  db: Db,
  boss: { send(name: string, data: object, options?: object): Promise<string | null> },
  now: Date,
): Promise<boolean> {
  const [last] = await db
    .select({ at: event.created_at })
    .from(event)
    .where(eq(event.action, COACH_TRIGGER_ACTION))
    .orderBy(desc(event.created_at))
    .limit(1);
  const lastCoachAt = last?.at ?? null;
  if (lastCoachAt && now.getTime() - lastCoachAt.getTime() < COACH_WAKE_WINDOW_SECONDS * 1000) {
    return false;
  }
  const lastLearnerAt = await loadLastLearnerEventAt(db);
  if (!lastLearnerAt) return false;
  if (lastCoachAt && lastLearnerAt.getTime() <= lastCoachAt.getTime()) return false;
  await boss.send(
    COACH_DAILY_QUEUE,
    {},
    { singletonKey: 'coach.wake', singletonSeconds: COACH_WAKE_WINDOW_SECONDS },
  );
  return true;
}
