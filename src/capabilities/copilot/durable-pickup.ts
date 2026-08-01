// YUK-575 (N6/MF-C) — durable run pickup-timeout detection.
//
// The problem (MF-C): `shouldEnqueueBackgroundJobs()` (runtime-env.ts) only blocks
// the TEST env (NODE_ENV==='test'||VITEST) — it has ZERO worker-liveness detection,
// and `boss.send` merely INSERTs a job row whether or not any worker consumes it.
// So if the worker is down / crash-looping / started without RW_WORKER, a durable
// run is enqueued but never picked up: the run sits at QUEUED forever (deriveCopilot
// RunStatus → 'queued'), an infinite spinner with no error. This module is the
// honest DETECTION primitive: the dispatch stamps a `pickup_deadline_ms` on the
// QUEUED event, and this pure predicate flags a run that blew past it without the
// worker ever touching it.
//
// The Dock consumes the same pure contract and surfaces a recoverable "still
// waiting" state after the deadline. It deliberately does NOT fail the run or
// dispatch an inline replacement: batchSize:1 means a healthy but busy worker can
// delay pickup, so the accepted handle remains authoritative and the human may
// reconnect later without creating a double outcome.

import { COPILOT_RUN_EVENTS } from './server/copilot-run-status';

/** How long after enqueue a durable run may sit un-picked-up before it is stalled. */
export const PICKUP_TIMEOUT_MS = 10_000;

/** Event types that prove the worker TOUCHED the run (picked it up). */
const WORKER_TOUCHED: ReadonlySet<string> = new Set<string>([
  COPILOT_RUN_EVENTS.STARTED,
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

/** Return the first valid QUEUED pickup deadline carried by the durable log. */
export function getDurablePickupDeadlineMs(events: DurablePickupEvent[]): number | undefined {
  const queued = events.find((event) => event.event_type === COPILOT_RUN_EVENTS.QUEUED);
  const deadline = (queued?.payload as { pickup_deadline_ms?: unknown } | undefined)
    ?.pickup_deadline_ms;
  return typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0
    ? deadline
    : undefined;
}

/**
 * Pure predicate: has this durable run stalled un-picked-up past its pickup deadline?
 *
 * true ⟺ a QUEUED event exists carrying a numeric `pickup_deadline_ms`, the worker
 * has NOT yet touched the run (no STARTED/DELTA/STEP/REPLY/DONE/FAILED),
 * and `nowMs` is past the deadline. Any worker touch (even a terminal FAILED) →
 * false (the run is not stalled-at-pickup; it ran). No deadline / no QUEUED → false
 * (nothing to judge). Unit-tested in durable-pickup.unit.test.ts; consumed by the
 * PR2 Dock run-state renderer (YUK-596).
 */
export function isDurablePickupStalled(events: DurablePickupEvent[], nowMs: number): boolean {
  const deadline = getDurablePickupDeadlineMs(events);
  if (deadline === undefined) return false;
  if (events.some((e) => WORKER_TOUCHED.has(e.event_type))) return false;
  return nowMs > deadline;
}
