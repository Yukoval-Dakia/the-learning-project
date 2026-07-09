// YUK-577 (should#8) — cross-package pg-boss queue names, dependency-free.
//
// This module MUST stay import-free (no DB, no boss/client) so that producers, the consumer
// manifest, AND unit tests can share one source of truth for a queue name without dragging a
// DB-tainted import into a unit test partition. `queue-config.ts` (which DOES pull boss/client for
// `isQueueCreateRace`) only points here in a comment — it does NOT re-export these constants;
// all callers import directly from this file.

/**
 * The copilot proactive-nudge evaluator queue. First producer(ingestion)→consumer(copilot)
 * three-package queue; both the ingestion post-commit `boss.send` and the copilot manifest handler
 * import this single constant so a rename can't silently send jobs to a worker-less queue
 * (`copilot_nudge_evaluate.queue.unit.test.ts` asserts it resolves to a registered handler).
 */
export const COPILOT_NUDGE_EVALUATE_QUEUE = 'copilot_nudge_evaluate';
