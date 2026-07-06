import type { Db } from '@/db/client';
import { writeCostLedger } from '@/server/ai/log';

export async function writeRetryableAiFailureLedger(db: Db, taskKind: string): Promise<void> {
  try {
    await writeCostLedger(db, {
      task_kind: taskKind,
      provider: 'unknown',
      model: 'unknown',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'failed_retryable',
    });
  } catch (err) {
    console.error(`[${taskKind}] writeCostLedger failed for retryable AI failure`, err);
  }
}

/**
 * YUK-379 (B1): permanent AI failure ledger — the LLM call itself SUCCEEDED
 * (cost incurred, `taskRunId` present) but a downstream deterministic step
 * (parse / schema validate) failed, so retrying is wasteful. Carrying
 * `taskRunId` is load-bearing: it lets this ledger row join into run-detail
 * observability (task_run_id join), making it the first real consumer of the
 * cost_ledger outcome column. Errors are swallowed like the retryable sibling —
 * a ledger hiccup must never mask the permanent classification.
 */
export async function writePermanentAiFailureLedger(
  db: Db,
  taskKind: string,
  taskRunId: string | null | undefined,
): Promise<void> {
  try {
    await writeCostLedger(db, {
      task_kind: taskKind,
      task_run_id: taskRunId ?? undefined,
      provider: 'unknown',
      model: 'unknown',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'failed_permanent',
    });
  } catch (err) {
    console.error(`[${taskKind}] writeCostLedger failed for permanent AI failure`, err);
  }
}
