// Legacy product-stage failure ledger helpers shared by capability-owned operations.
// These remain central because they project AI attempt observability, not knowledge semantics.
import type { Db, Tx } from '@/db/client';
import { writeCostLedger } from '@/server/ai/log';

export async function writeRetryableAiFailureLedger(
  db: Db | Tx,
  taskKind: string,
  options: { throwOnError?: boolean } = {},
): Promise<void> {
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
    // A failed statement poisons the surrounding PostgreSQL transaction. Let
    // transactional callers preserve the original error rather than catching it
    // here and surfacing a later, misleading 25P02 from a sibling durable write.
    if (options.throwOnError) throw err;
    console.error(`[${taskKind}] writeCostLedger failed for retryable AI failure`, err);
  }
}

/**
 * YUK-379 (B1): permanent AI failure ledger — the LLM call itself SUCCEEDED
 * (cost incurred) but a downstream deterministic step (parse / schema validate)
 * failed, so retrying is wasteful. When present, `taskRunId` lets this row join
 * into run-detail observability (the task_run_id join) — the row is written FOR
 * that read surface. If the task runner returned no task_run_id the row degrades
 * to task_run_id=NULL. A capability may provide a durable job correlation key,
 * query the outcome + key as its terminal marker, and require the write to
 * succeed before acknowledging the job.
 */
export async function writePermanentAiFailureLedger(
  db: Db | Tx,
  taskKind: string,
  taskRunId: string | null | undefined,
  options: { pgbossJobId?: string; throwOnError?: boolean } = {},
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
      pgboss_job_id: options.pgbossJobId,
    });
  } catch (err) {
    if (options.throwOnError) throw err;
    console.error(`[${taskKind}] writeCostLedger failed for permanent AI failure`, err);
  }
}
