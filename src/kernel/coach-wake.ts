// The coach_daily on-return obligation. Practice's learner_return_wake enqueues through
// here, so the singleton key and window have one owner. Agency's manifest keeps the job
// name as a literal for the task census; the two must match.

import { createHash } from 'node:crypto';
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
 * 24h return window. The job id is a deterministic UUID derived from
 * (goal, source event): pg-boss's singleton index is keyed on
 * (name, singleton_key, singleton_on) where singleton_on is a TIME SLOT — a
 * redelivery crossing a slot boundary would otherwise bill a second same-day
 * coach run for one event. With an explicit id the send is INSERT … ON
 * CONFLICT DO NOTHING, deduping regardless of slot (same pattern as practice's
 * sendJobIdempotent; kept inline because agency must not import practice).
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
      id: steeringJobUuid('coach', goalId, sourceEventId),
      singletonKey: `coach.steering.${goalId}.${sourceEventId}`,
      singletonSeconds: 24 * 60 * 60,
    },
  );
}

/** Deterministic UUID (RFC 4122 shape, sha1-based) so redeliveries map to one job row. */
export function steeringJobUuid(
  prefix: 'coach' | 'supply',
  goalId: string,
  eventId: string,
): string {
  const h = createHash('sha1').update(`${prefix}.steering.${goalId}.${eventId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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
