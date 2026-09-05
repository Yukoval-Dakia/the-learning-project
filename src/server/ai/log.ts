import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { TaskKind } from '@/ai/registry';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, cost_ledger, tool_call_log } from '@/db/schema';
import type { AttemptCostBasis, AttemptCostTruth } from './attempt-cost';

// cost_ledger / tool_call_log are loose-coupled correlation logs (no FK); a single
// INSERT/UPDATE works against either a top-level Db or a Tx. Accepting DbLike lets callers
// fold the write into a surrounding transaction (YUK-227 image_candidate accept folds
// the per-accept cost row into the question-INSERT tx for atomicity). FIX-R2-10 — all
// THREE correlation-log writers (writeCostLedger, writeToolCallLog,
// setToolCallLogMirroredEventId) accept DbLike for the same reason; only the ai_task_runs
// lifecycle writers below stay Db (they are written by the runner outside any caller tx).
type DbLike = Db | Tx;

export interface ToolCallLogEntry {
  task_run_id: string;
  task_kind: string;
  tool_name: string;
  input_json: unknown;
  output_json: unknown;
  iteration: number;
  latency_ms: number;
  cost: number;
  /** YUK-79: 'read' | 'propose' | 'write' for tools dispatched via DomainTool registry. Omit for legacy SDK auto-mirror. */
  effect?: 'read' | 'propose' | 'write';
  /** YUK-79: set when tool execution hard-fails (timeout / parse / unsupported). */
  error_reason?: string;
  /** YUK-79: set by Lane D when mirrorEvent policy writes an event mirror; FK to event.id. */
  mirrored_event_id?: string;
}

export async function writeToolCallLog(db: DbLike, entry: ToolCallLogEntry): Promise<string> {
  const id = createId();
  await db.insert(tool_call_log).values({
    id,
    task_run_id: entry.task_run_id,
    task_kind: entry.task_kind,
    tool_name: entry.tool_name,
    effect: entry.effect ?? null,
    input_json: entry.input_json as Record<string, unknown>,
    output_json: entry.output_json as Record<string, unknown>,
    error_reason: entry.error_reason ?? null,
    iteration: entry.iteration,
    latency_ms: entry.latency_ms,
    cost: entry.cost,
    occurred_at: new Date(),
    mirrored_event_id: entry.mirrored_event_id ?? null,
  });
  return id;
}

/** Warn when a tool-calling task has no MCP servers configured in its context. */
export function logMissingMcpServersWarning(entry: {
  task_run_id: string;
  task_kind: string;
}): void {
  console.warn('[runTask] missing_mcp_servers', {
    event: 'missing_mcp_servers',
    task_run_id: entry.task_run_id,
    kind: entry.task_kind,
  });
}

/** YUK-79: backfill `mirrored_event_id` after mirrorEvent policy fires. */
export async function setToolCallLogMirroredEventId(
  db: DbLike,
  toolCallLogId: string,
  eventId: string,
): Promise<void> {
  await db
    .update(tool_call_log)
    .set({ mirrored_event_id: eventId })
    .where(eq(tool_call_log.id, toolCallLogId));
}

interface CostLedgerEntryBase {
  task_run_id?: string;
  task_kind: string;
  provider: string;
  model: string;
  /** YUK-359: currency of `cost`. Defaults to 'USD' (mimo/anthropic runner path).
   *  GLM-OCR + memory (GLM/百炼) write 'CNY'. Read paths MUST group by currency. */
  currency?: 'USD' | 'CNY';
  tokens_in: number;
  tokens_out: number;
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

export interface AiTaskRunStartEntry {
  id: string;
  task_kind: TaskKind;
  provider: string;
  model: string;
  input_hash: string;
  compiledPromptHash?: string;
  promptCodecVersion?: string;
  promptCodecMode?: 'cold' | 'resume';
  promptContextDigest?: string;
  started_at?: Date;
}

export async function writeAiTaskRunStarted(db: Db, entry: AiTaskRunStartEntry): Promise<void> {
  await db.insert(ai_task_runs).values({
    id: entry.id,
    task_kind: entry.task_kind,
    provider: entry.provider,
    model: entry.model,
    input_hash: entry.input_hash,
    compiled_prompt_hash: entry.compiledPromptHash ?? null,
    prompt_codec_version: entry.promptCodecVersion ?? null,
    prompt_codec_mode: entry.promptCodecMode ?? null,
    prompt_context_digest: entry.promptContextDigest ?? null,
    status: 'running',
    finish_reason: null,
    usage_json: { inputTokens: 0, outputTokens: 0 },
    cost_usd: null,
    cost_basis: null,
    cost_ref: null,
    error_message: null,
    started_at: entry.started_at ?? new Date(),
    finished_at: null,
  });
}

export interface AiTaskUsage {
  inputTokens: number;
  outputTokens: number;
  /** Metadata-only proof that the SDK returned reasoning blocks; raw CoT is never persisted. */
  thinkingBlocks?: number;
  thinkingCharacters?: number;
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
      usage_json: entry.usage ?? { inputTokens: 0, outputTokens: 0 },
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

/**
 * Mark a settled failure only after the next SDK query has actually started.
 * A missed marker is conservative (`error`); a false positive is forbidden.
 */
export async function writeAiTaskRunRetried(db: DbLike, id: string): Promise<boolean> {
  const rows = await db
    .update(ai_task_runs)
    .set({ finish_reason: 'error_retried' })
    .where(
      and(
        eq(ai_task_runs.id, id),
        eq(ai_task_runs.status, 'failure'),
        eq(ai_task_runs.finish_reason, 'error'),
      ),
    )
    .returning({ id: ai_task_runs.id });
  return rows.length === 1;
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
 * Commit the two durable projections of one AI attempt as one unit.
 *
 * The transaction is intentionally owned here rather than by an adapter: every
 * runner path gets exactly one ai_task_runs terminal update and one attempt
 * ledger row carrying the same amount / basis / ref. A ledger uniqueness or
 * constraint failure therefore rolls the terminal update back too.
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
