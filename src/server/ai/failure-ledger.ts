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
 * YUK-379 (B1) — permanent AI failure ledger: the LLM call SUCCEEDED (cost
 * incurred) but a downstream deterministic step failed, so retrying is wasteful.
 * `taskRunId` joins the row into run-detail observability; without one it degrades
 * to NULL. A capability may require the write to succeed before acking its job.
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
