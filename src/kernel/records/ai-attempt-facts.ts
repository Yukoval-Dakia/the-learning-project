import { and, eq } from 'drizzle-orm';
import type { AiTaskUsage, AttemptCostBasis, AttemptCostTruth } from '@/ai/task-result';
import { newId as createId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, cost_ledger } from '@/db/schema';

// cost_ledger is a loose-coupled correlation log (no FK), so one INSERT works
// against either a top-level Db or a Tx. Accepting DbLike lets callers fold the
// write into a surrounding transaction (YUK-227 image_candidate accept folds its
// cost row into the question-INSERT tx); tool-call writers in
// kernel/tools/call-evidence keep the same contract (FIX-R2-10). The ai_task_runs
// lifecycle writers below stay Db (runner-owned, outside caller txs).
type DbLike = Db | Tx;

interface CostLedgerEntryBase {
  task_run_id?: string;
  task_kind: string;
  provider: string;
  model: string;
  /** YUK-359: currency of `cost`. Defaults to 'USD' (mimo/anthropic runner path).
   *  GLM-OCR + memory (GLM/百炼) write 'CNY'. Read paths MUST group by currency. */
  currency?: 'USD' | 'CNY';
  tokens_in: number | null;
  tokens_out: number | null;
  /** Sub 0c: track pg-boss job correlation + outcome for OCR / async jobs. */
  outcome?: 'success' | 'failed_retryable' | 'failed_permanent';
  pgboss_job_id?: string;
  occurred_at?: Date;
}

/** Public writer contract: non-runner evidence is always explicitly legacy. */
export type CostLedgerEntry = CostLedgerEntryBase & { cost: number };

type AttemptCostLedgerEntry = CostLedgerEntryBase & {
  task_run_id: string;
  cost: number | null;
  cost_basis: AttemptCostBasis;
  cost_ref: string;
};

export async function writeCostLedger(db: DbLike, entry: CostLedgerEntry): Promise<void> {
  await insertCostLedger(db, { ...entry, entry_kind: 'legacy' });
}

/**
 * One models-catalog auth probe. Uses the attempt columns so an unpriced call stays
 * `cost = null` instead of a legacy zero. Not a runner task run.
 */
export async function writeModelCatalogProbeCost(
  db: DbLike,
  entry: {
    provider: string;
    model: string;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    costBasis: AttemptCostBasis;
    costRef: string;
    outcome: 'success' | 'failed_permanent' | 'failed_retryable';
    occurredAt: Date;
  },
): Promise<void> {
  const unknown = entry.costBasis === 'unknown' || entry.costUsd === null;
  await insertCostLedger(db, {
    entry_kind: 'attempt',
    task_run_id: `catalog-probe:${entry.provider}:${entry.occurredAt.toISOString()}`,
    task_kind: 'model_catalog_auth_probe',
    provider: entry.provider,
    model: entry.model,
    cost: unknown ? null : entry.costUsd,
    cost_basis: unknown ? 'unknown' : entry.costBasis,
    cost_ref: entry.costRef,
    currency: 'USD',
    tokens_in: entry.tokensIn,
    tokens_out: entry.tokensOut,
    outcome: entry.outcome,
    occurred_at: entry.occurredAt,
  });
}

async function insertCostLedger(
  db: DbLike,
  entry:
    | (CostLedgerEntry & { entry_kind: 'legacy' })
    | (AttemptCostLedgerEntry & { entry_kind: 'attempt' }),
): Promise<void> {
  await db.insert(cost_ledger).values({
    id: createId(),
    task_run_id: entry.task_run_id ?? null,
    task_kind: entry.task_kind,
    provider: entry.provider,
    model: entry.model,
    cost: entry.cost,
    currency: entry.currency ?? 'USD',
    entry_kind: entry.entry_kind,
    cost_basis: entry.entry_kind === 'attempt' ? entry.cost_basis : null,
    cost_ref: entry.entry_kind === 'attempt' ? entry.cost_ref : null,
    tokens_in: entry.tokens_in,
    tokens_out: entry.tokens_out,
    outcome: entry.outcome ?? 'success',
    pgboss_job_id: entry.pgboss_job_id ?? null,
    occurred_at: entry.occurred_at ?? new Date(),
  });
}

export interface AiTaskRunFinishEntry {
  id: string;
  status: 'success' | 'failure';
  finish_reason?: string | null;
  usage?: AiTaskUsage;
  cost_usd?: number | null;
  cost_basis?: AttemptCostBasis | null;
  cost_ref?: string | null;
  error_message?: string | null;
  finished_at?: Date;
}

export async function writeAiTaskRunFinished(
  db: DbLike,
  entry: AiTaskRunFinishEntry,
): Promise<{ id: string; task_kind: string; provider: string; model: string } | null> {
  const rows = await db
    .update(ai_task_runs)
    .set({
      status: entry.status,
      finish_reason: entry.finish_reason ?? null,
      usage_json: entry.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        numTurns: 0,
      },
      cost_usd: entry.cost_usd ?? null,
      cost_basis: entry.cost_basis ?? null,
      cost_ref: entry.cost_ref ?? null,
      error_message: entry.error_message ?? null,
      finished_at: entry.finished_at ?? new Date(),
    })
    .where(and(eq(ai_task_runs.id, entry.id), eq(ai_task_runs.status, 'running')))
    .returning({
      id: ai_task_runs.id,
      task_kind: ai_task_runs.task_kind,
      provider: ai_task_runs.provider,
      model: ai_task_runs.model,
    });
  return rows[0] ?? null;
}

export interface AiTaskAttemptFinishEntry {
  id: string;
  status: 'success' | 'failure';
  finish_reason: string;
  usage: AiTaskUsage;
  cost_truth: AttemptCostTruth;
  outcome: 'success' | 'failed_retryable' | 'failed_permanent';
  error_message?: string | null;
  finished_at?: Date;
}

/**
 * Commit the two durable projections of one attempt as one unit: every runner path
 * gets exactly one ai_task_runs terminal update and one ledger row with the same
 * amount/basis/ref, so a ledger failure rolls the terminal update back.
 */
export async function writeAiTaskAttemptFinished(
  db: Db,
  entry: AiTaskAttemptFinishEntry,
): Promise<boolean> {
  const finishedAt = entry.finished_at ?? new Date();
  return db.transaction(async (tx) => {
    const settledRun = await writeAiTaskRunFinished(tx, {
      id: entry.id,
      status: entry.status,
      finish_reason: entry.finish_reason,
      usage: entry.usage,
      cost_usd: entry.cost_truth.amountUsd,
      cost_basis: entry.cost_truth.basis,
      cost_ref: entry.cost_truth.ref,
      error_message: entry.error_message,
      finished_at: finishedAt,
    });
    if (!settledRun) return false;
    await insertCostLedger(tx, {
      entry_kind: 'attempt',
      task_run_id: entry.id,
      task_kind: settledRun.task_kind,
      provider: settledRun.provider,
      model: settledRun.model,
      cost: entry.cost_truth.amountUsd,
      cost_basis: entry.cost_truth.basis,
      cost_ref: entry.cost_truth.ref,
      currency: 'USD',
      tokens_in: entry.usage.inputTokens,
      tokens_out: entry.usage.outputTokens,
      outcome: entry.outcome,
      occurred_at: finishedAt,
    });
    return true;
  });
}

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
