// YUK-576 §5 — stuck-in-running reconcile sweeper for ai_task_runs.
//
// The runner's terminal finish-write can fail (DB outage) or the process can
// die before the finally block — the row then sticks at status='running'
// forever. The stream paths have warned about this since YUK-240
// (`task_run_stuck_in_running` structured warns, runner.ts) with "a real
// reconcile job is the follow-up"; the runTask (judge) paths were even quieter
// (console.error only, warns added alongside this sweeper). This module IS
// that reconcile job.
//
// Semantics — OBSERVATION-STATE CONVERGENCE ONLY:
//   - touches ONLY ai_task_runs rows; no domain writes, no job re-emission, no
//     LLM re-run (the run's business side effects are owned elsewhere).
//   - terminal status is 'failure' (NOT 'error'): the write vocabulary is the
//     closed enum {running, success, failure} (log.ts AiTaskRunFinishEntry) —
//     'error' would be invisible to the admin failure surface
//     (ai-observability.ts filters eq(status,'failure')). The sub-class rides
//     finish_reason='reconciled_stuck', which the overnight watchdog EXCLUDES
//     from degraded-kind alerting (not a logical task failure) while the admin
//     Failures page keeps it browsable (alerting-excluded, browse-retained).
//   - threshold 1h vs the largest EFFECTIVE run lifetime (bounded by the
//     cooperative abort timer) = margin: a >1h 'running' row cannot be a live run,
//     so false convergence is structurally excluded. The largest *registry*
//     budget.timeout is 300s (12× margin), BUT YUK-575's durable copilot run
//     overrides its abort timer per-call to DURABLE_BUDGET.timeoutMs (12min, via
//     the runner budgetOverride seam), so the largest EFFECTIVE run lifetime is
//     12min → margin 5×. Still structurally safe (12min < 1h). LOAD-BEARING
//     invariant (YUK-575 S6): DURABLE_BUDGET.timeoutMs — and any future per-call
//     budget override — MUST stay < STUCK_RUN_THRESHOLD_MS; a ≥1h durable budget
//     would let this sweeper converge a LIVE run into a false failure.
//     (copilot_run.test.ts asserts DURABLE_BUDGET.timeoutMs < STUCK_RUN_THRESHOLD_MS.)
//
// Triggers (design doc §5.4):
//   - PRIMARY: one boot-time sweep in start-worker.ts (process crash is the
//     main stuck cause; restart converges within seconds — the 1h threshold
//     guards the previous process's youngest runs).
//   - SECONDARY: a nightly fast-tier cron (observability manifest) for the
//     DB-outage flavor where no restart happens. fast tier has no DLQ by
//     design: the sweep is idempotent, a dropped tick re-converges next cron.

import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { and, eq, lt } from 'drizzle-orm';
import type { Job } from 'pg-boss';

/** 1h — 12× the largest task budget.timeout (300s); see module doc. */
export const STUCK_RUN_THRESHOLD_MS = 3_600_000;

/** finish_reason discriminator for sweeper-converged rows. */
export const RECONCILED_STUCK_FINISH_REASON = 'reconciled_stuck';

export interface ReconcileResult {
  reconciled: number;
}

/**
 * Converge every ai_task_runs row stuck at status='running' for longer than
 * STUCK_RUN_THRESHOLD_MS to a terminal failure row. Idempotent: converged rows
 * no longer match the WHERE clause.
 */
export async function reconcileStuckAiTaskRuns(
  db: Db,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const cutoff = new Date(now.getTime() - STUCK_RUN_THRESHOLD_MS);
  const converged = await db
    .update(ai_task_runs)
    .set({
      status: 'failure',
      finish_reason: RECONCILED_STUCK_FINISH_REASON,
      finished_at: now,
      error_message:
        'reconciled by stuck-run sweeper: no terminal write within threshold (process died or finish-write failed)',
    })
    .where(and(eq(ai_task_runs.status, 'running'), lt(ai_task_runs.started_at, cutoff)))
    .returning({ id: ai_task_runs.id, task_kind: ai_task_runs.task_kind });

  if (converged.length > 0) {
    console.warn('[ai_task_run_reconcile] converged stuck runs', {
      event: 'task_run_stuck_reconciled',
      reconciled: converged.length,
      // Truncated sample — enough to jump into the admin run detail, without
      // flooding the log line when a long outage left many rows behind.
      sample: converged.slice(0, 10),
    });
  }
  return { reconciled: converged.length };
}

/**
 * pg-boss handler factory (JobHandlerFactory shape `(db) => (jobs) => Promise<void>`),
 * mounted by register-capability-jobs.ts from the observability manifest's
 * nightly cron JobDecl. The job payload is empty; `now` is the wall clock.
 */
export function buildAiTaskRunReconcileHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async (jobs) => {
    for (const _job of jobs) {
      const result = await reconcileStuckAiTaskRuns(db);
      console.log(`[ai_task_run_reconcile] nightly sweep -> ${result.reconciled} reconciled`);
    }
  };
}
