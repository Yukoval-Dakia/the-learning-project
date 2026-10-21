// Durable run pickup-timeout detection.
//
// `shouldEnqueueBackgroundJobs()` only blocks the TEST env — it has no worker-liveness
// detection, and `boss.send` merely inserts a job row. If the worker is down / crash-
// looping / started without RW_WORKER, the run sits at QUEUED forever. A physical
// dispatch stamps `pickup_deadline_ms` on DISPATCHED (or, for legacy runs, QUEUED), and
// this pure predicate flags a run that blew past it without any worker touch. The Dock
// uses the same contract to show a recoverable "still waiting" state; it deliberately
// does NOT fail the run or dispatch an inline replacement (batchSize:1 means a healthy
// but busy worker can delay pickup, so the accepted handle stays authoritative).

import { COPILOT_RUN_EVENTS } from './server/copilot-run-status';

/** How long a dispatched run may sit un-picked-up before it is considered stalled. */
export const PICKUP_TIMEOUT_MS = 10_000;

/** Event types that prove the worker touched (picked up) the run. */
const WORKER_TOUCHED: ReadonlySet<string> = new Set<string>([
  COPILOT_RUN_EVENTS.STARTED,
  COPILOT_RUN_EVENTS.EXECUTION_STARTED,
  COPILOT_RUN_EVENTS.DELTA,
  COPILOT_RUN_EVENTS.STEP,
  COPILOT_RUN_EVENTS.REPLY,
  COPILOT_RUN_EVENTS.DONE,
  COPILOT_RUN_EVENTS.FAILED,
]);

/** Minimal replay-event read shape (event_type + the QUEUED deadline in payload). */
export interface DurablePickupEvent {
  event_type: string;
  payload?: unknown;
}

/** Canonical worker-touch predicate shared by pickup UX and legacy recovery. */
export function isDurableWorkerTouchEvent(event: DurablePickupEvent): boolean {
  return WORKER_TOUCHED.has(event.event_type);
}

export function hasDurableWorkerTouch(events: DurablePickupEvent[]): boolean {
  return events.some(isDurableWorkerTouchEvent);
}

/**
 * Return the physical-dispatch pickup deadline. Session-queue v2 turns may
 * remain accepted-but-waiting with only QUEUED, so their clock starts at
 * DISPATCHED. Legacy runs keep their deadline on QUEUED.
 */
export function getDurablePickupDeadlineMs(events: DurablePickupEvent[]): number | undefined {
  const dispatched = events.find((event) => event.event_type === COPILOT_RUN_EVENTS.DISPATCHED);
  const queued = events.find((event) => event.event_type === COPILOT_RUN_EVENTS.QUEUED);
  const deadline = (
    (dispatched?.payload ?? queued?.payload) as { pickup_deadline_ms?: unknown } | undefined
  )?.pickup_deadline_ms;
  return typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0
    ? deadline
    : undefined;
}

/**
 * True when a physical dispatch (or legacy QUEUED) carries a numeric deadline, the
 * worker has not touched the run yet, and `nowMs` is past the deadline. Any worker
 * touch (even a terminal FAILED) → false, as does a missing deadline.
 */
export function isDurablePickupStalled(events: DurablePickupEvent[], nowMs: number): boolean {
  const deadline = getDurablePickupDeadlineMs(events);
  if (deadline === undefined) return false;
  if (hasDurableWorkerTouch(events)) return false;
  return nowMs > deadline;
}
