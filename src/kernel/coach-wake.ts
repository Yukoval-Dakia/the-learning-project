// The coach_daily on-return obligation. Practice's learner_return_wake enqueues through
// here, so the singleton key and window have one owner. Agency's manifest keeps the job
// name as a literal for the task census; the two must match.

import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { loadLastLearnerEventAt } from '@/kernel/read-models/learner-activity';

export const COACH_DAILY_QUEUE = 'coach_daily';

// pg-boss keeps one job per key per 24h slot, the same one-job-a-day bound the
// nightly DAG had. A job's retries (llm tier) each bill a CoachTask attempt, as before.
const COACH_WAKE_WINDOW_SECONDS = 24 * 60 * 60;
// Written by the agency scan owner at the start of every coach run, success or not,
// so a failed run also counts as this window's attempt.
const COACH_TRIGGER_ACTION = 'experimental:trigger_coach_scan';

/**
 * YUK-1770 (D5) — steering change wake: enqueue coach_daily NOW, bypassing the
 * 24h return window. Keyed per (goal, source event id) so retries of ONE
 * delivery collapse (a completed job still holds its pg-boss singleton slot)
 * while a NEW steering change always gets its own job — exam sentence then
 * 「考试取消了」 minutes apart each trigger their own same-day re-plan.
 * singletonSeconds spans a day: delivery replays beyond the handler's own
 * retry window still dedupe; only a different event id opens a new slot.
 */
export async function enqueueCoachForSteering(
  boss: { send(name: string, data: object, options?: object): Promise<string | null> },
  goalId: string,
  sourceEventId: string,
): Promise<string | null> {
  return boss.send(
    COACH_DAILY_QUEUE,
    { reason: 'steering_changed', goal_id: goalId, source_event_id: sourceEventId },
    {
      singletonKey: `coach.steering.${goalId}.${sourceEventId}`,
      singletonSeconds: 24 * 60 * 60,
    },
  );
}

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
  const jobId = await boss.send(
    COACH_DAILY_QUEUE,
    {},
    { singletonKey: 'coach.wake', singletonSeconds: COACH_WAKE_WINDOW_SECONDS },
  );
  return jobId !== null;
}
