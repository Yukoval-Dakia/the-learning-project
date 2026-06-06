import type { Db, Tx } from '@/db/client';
import { ai_task_runs, cost_ledger, tool_call_log } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

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

export interface CostLedgerEntry {
  task_run_id?: string;
  task_kind: string;
  provider: string;
  model: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  /** Sub 0c: track pg-boss job correlation + outcome for OCR / async jobs. */
  outcome?: 'success' | 'failed_retryable' | 'failed_permanent';
  pgboss_job_id?: string;
}

export async function writeCostLedger(db: DbLike, entry: CostLedgerEntry): Promise<void> {
  await db.insert(cost_ledger).values({
    id: createId(),
    task_run_id: entry.task_run_id ?? null,
    task_kind: entry.task_kind,
    provider: entry.provider,
    model: entry.model,
    cost: entry.cost,
    tokens_in: entry.tokens_in,
    tokens_out: entry.tokens_out,
    outcome: entry.outcome ?? 'success',
    pgboss_job_id: entry.pgboss_job_id ?? null,
    occurred_at: new Date(),
  });
}

export interface AiTaskRunStartEntry {
  id: string;
  task_kind: string;
  provider: string;
  model: string;
  input_hash: string;
  started_at?: Date;
}

export async function writeAiTaskRunStarted(db: Db, entry: AiTaskRunStartEntry): Promise<void> {
  await db.insert(ai_task_runs).values({
    id: entry.id,
    task_kind: entry.task_kind,
    provider: entry.provider,
    model: entry.model,
    input_hash: entry.input_hash,
    status: 'running',
    finish_reason: null,
    usage_json: { inputTokens: 0, outputTokens: 0 },
    cost_usd: null,
    error_message: null,
    started_at: entry.started_at ?? new Date(),
    finished_at: null,
  });
}

export interface AiTaskRunFinishEntry {
  id: string;
  status: 'success' | 'failure';
  finish_reason?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  cost_usd?: number;
  error_message?: string | null;
  finished_at?: Date;
}

export async function writeAiTaskRunFinished(db: Db, entry: AiTaskRunFinishEntry): Promise<void> {
  await db
    .update(ai_task_runs)
    .set({
      status: entry.status,
      finish_reason: entry.finish_reason ?? null,
      usage_json: entry.usage ?? { inputTokens: 0, outputTokens: 0 },
      cost_usd: entry.cost_usd ?? null,
      error_message: entry.error_message ?? null,
      finished_at: entry.finished_at ?? new Date(),
    })
    .where(eq(ai_task_runs.id, entry.id));
}
