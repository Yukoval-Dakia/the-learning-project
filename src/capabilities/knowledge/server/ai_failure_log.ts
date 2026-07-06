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
 * (cost incurred) but a downstream deterministic step (parse / schema validate)
 * failed, so retrying is wasteful. When present, `taskRunId` lets this row join
 * into run-detail observability (the task_run_id join) — the row is written FOR
 * that read surface; no query consumes the outcome column itself yet. If the
 * task runner returned no task_run_id the row degrades to task_run_id=NULL
 * (visible only via direct SQL — the same invisibility the backfill doc
 * describes). Errors are swallowed like the retryable sibling — a ledger hiccup
 * must never mask the permanent classification.
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
