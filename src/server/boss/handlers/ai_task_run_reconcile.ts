// A crash or a failed finish-write leaves ai_task_runs at 'running'.
// This sweep writes the observation row only. It does not rerun the model or the domain write.
// Status is 'failure', not 'error'. The admin page filters on 'failure'.
// finish_reason reconciled_stuck stays out of the degraded alert and stays on the failures page.
// Every per-call budget must stay under STUCK_RUN_THRESHOLD_MS. A longer budget is a live run.
// Boot sweeps the crash case. The nightly fast cron covers an outage with no restart.
// That queue has no dead-letter queue. A dropped tick converges on the next one.

import { and, eq, lt } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { unknownAttemptCostTruth } from '@/server/ai/attempt-cost';
import { writeAiTaskAttemptFinished } from '@/server/ai/log';

/** Shared lifetime boundary, also enforced by configuration and caller overrides. */
export { STUCK_RUN_THRESHOLD_MS };

/** finish_reason discriminator for sweeper-converged rows. */
export const RECONCILED_STUCK_FINISH_REASON = 'reconciled_stuck';

export interface ReconcileResult {
  reconciled: number;
}

/** Idempotent. A converged row no longer matches the status filter. */
export async function reconcileStuckAiTaskRuns(
  db: Db,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const cutoff = new Date(now.getTime() - STUCK_RUN_THRESHOLD_MS);
  const staleRuns = await db
    .select({
      id: ai_task_runs.id,
      task_kind: ai_task_runs.task_kind,
      provider: ai_task_runs.provider,
      model: ai_task_runs.model,
    })
    .from(ai_task_runs)
    .where(and(eq(ai_task_runs.status, 'running'), lt(ai_task_runs.started_at, cutoff)))
    .orderBy(ai_task_runs.started_at, ai_task_runs.id);

  const converged: Array<{ id: string; task_kind: string }> = [];
  for (const run of staleRuns) {
    // One row's constraint error rolls that row back to 'running' and the next tick retries it.
    // Letting it escape would skip every later row until the next cron.
    let settled: boolean;
    try {
      settled = await writeAiTaskAttemptFinished(db, {
        id: run.id,
        status: 'failure',
        finish_reason: RECONCILED_STUCK_FINISH_REASON,
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_truth: unknownAttemptCostTruth(run.provider, run.model),
        // The sweeper cannot distinguish a pre-provider process death from a
        // post-provider terminal-write fault. Retrying an unknown may double-bill
        // or repeat side effects, so follow the runner's whitelist-only policy.
        outcome: 'failed_permanent',
        error_message:
          'reconciled by stuck-run sweeper: no terminal write within threshold (process died or finish-write failed)',
        finished_at: now,
      });
    } catch (error) {
      // Log the driver summary only. The run payload stays out of the log.
      console.warn('[ai_task_run_reconcile] settle failed for stuck run', {
        event: 'task_run_reconcile_failed',
        task_run_id: run.id,
        kind: run.task_kind,
        err: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (settled) converged.push({ id: run.id, task_kind: run.task_kind });
  }

  if (converged.length > 0) {
    console.warn('[ai_task_run_reconcile] converged stuck runs', {
      event: 'task_run_stuck_reconciled',
      reconciled: converged.length,
      // A long outage can leave many rows. The sample is enough to open one.
      sample: converged.slice(0, 10),
    });
  }
  return { reconciled: converged.length };
}

/** Nightly cron. The payload is unused. The clock is the wall clock inside the sweep. */
export function buildAiTaskRunReconcileHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async (jobs) => {
    for (const _job of jobs) {
      const result = await reconcileStuckAiTaskRuns(db);
      console.log(`[ai_task_run_reconcile] nightly sweep -> ${result.reconciled} reconciled`);
    }
  };
}
