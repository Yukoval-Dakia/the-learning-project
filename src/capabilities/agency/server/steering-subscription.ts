// YUK-1770 steering-changed subscription — the single goal-event reaction line.
//
// Consumes the goal write events (genesis / status / scope) the record_steering
// path already produces — no parallel event stream. Non-steering goal writes
// (manual goals, proposal materializations) skip. On a real steering change, the
// same-day contract fires: (1) coach re-plan via enqueueCoachForSteering (D5 —
// bypasses the 24h return window), (2) a supply-planner run, (3) today's
// practice stream recomposes when no practice session is open. The companion
// context refresh needs no enqueue: the learner-state header re-assembles on the
// new goal_at watermark next turn.

import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { goal } from '@/db/schema';
import { enqueueCoachForSteering } from '@/kernel/coach-wake';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { isInActivePracticeSession } from '@/kernel/read-models/practice-session-open';
import { getStartedBoss } from '@/server/boss/client';

interface SteeringSubscriptionDeps {
  bossSend?: (name: string, data: object, options?: object) => Promise<string | null>;
  recomposeTodayPracticeFn?: (db: Db) => Promise<boolean>;
}

async function handleSteeringChangeDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: SteeringSubscriptionDeps = {},
): Promise<EventSubscriptionOutcome> {
  // The delivery carries only ids; the source event row identifies the goal.
  const { event } = await import('@/db/schema');
  const [source] = await db
    .select({
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      created_at: event.created_at,
    })
    .from(event)
    .where(eq(event.id, delivery.sourceEventId));
  if (source?.subject_kind !== 'goal') {
    return { status: 'skipped', reason: 'source event is not a goal write' };
  }

  // Only steering goals react: a live row must carry the payload; a deleted row
  // (fold-null cleanup) still reacts when the genesis payload says steering.
  const [row] = await db
    .select({ id: goal.id, steering: goal.steering })
    .from(goal)
    .where(eq(goal.id, source.subject_id));
  if (row) {
    if (row.steering == null) {
      return { status: 'skipped', reason: 'goal is not a steering goal' };
    }
  } else {
    const { event: eventTable } = await import('@/db/schema');
    const [genesis] = await db
      .select({ payload: eventTable.payload })
      .from(eventTable)
      .where(eq(eventTable.id, delivery.sourceEventId));
    const rowSnapshot = (genesis?.payload as { row?: { steering?: unknown } } | null)?.row;
    if (rowSnapshot?.steering == null) {
      return { status: 'skipped', reason: 'goal is not a steering goal' };
    }
  }

  const boss = await getStartedBoss();
  const send =
    deps.bossSend ?? ((name: string, data: object, opts?: object) => boss.send(name, data, opts));
  const goalId = source.subject_id;
  // Per-event singleton keys: retries of this delivery collapse; a NEW steering
  // event always opens its own slot (P1-1 — exam then cancel minutes apart each
  // get their own same-day re-plan / supply rerun).
  const sourceEventId = delivery.sourceEventId;

  const coachJobId = await enqueueCoachForSteering(boss, goalId, sourceEventId);
  const detail: Record<string, unknown> = { goal_id: goalId, source_event_id: sourceEventId };
  detail.coach_job_id = coachJobId;

  const supplyJobId = await send(
    'supply_planner',
    { reason: 'steering_changed', goal_id: goalId, source_event_id: sourceEventId },
    {
      singletonKey: `supply.steering.${goalId}.${sourceEventId}`,
      singletonSeconds: 24 * 60 * 60,
    },
  );
  detail.supply_job_id = supplyJobId;

  // Recompose today's pending practice only when the learner is not mid-session;
  // an open session keeps its committed queue (the next compose picks steering up).
  try {
    if (!(await isInActivePracticeSession(db))) {
      // Practice installs the recompose operation behind the kernel port at
      // composition time; agency never imports practice (boundary ratchet).
      const recomposeFn =
        deps.recomposeTodayPracticeFn ??
        ((d: Db) => import('@/kernel/steering-recompose').then((m) => m.recomposeTodayPractice(d)));
      const recomposed = await recomposeFn(db);
      detail.practice_recomposed = recomposed;
      if (!recomposed) detail.practice_recompose_not_installed = true;
    } else {
      detail.practice_recomposed = false;
      detail.practice_session_open = true;
    }
  } catch (err) {
    // Recomposition is a convenience refresh; the coach re-plan and supply run
    // already carry the direction change. Surface, never fail the delivery.
    console.error('[steering-subscription] practice recompose failed (best-effort)', {
      goal_id: goalId,
      err,
    });
    detail.practice_recomposed = false;
    detail.practice_recompose_error = true;
  }

  return { status: 'succeeded', detail };
}

export const buildSteeringChangedSubscriber: EventSubscriptionHandlerFactory = (db: Db) => {
  return (delivery) => handleSteeringChangeDelivery(db, delivery);
};
