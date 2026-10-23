import { eq } from 'drizzle-orm';
import { newId as createId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { cost_ledger, tool_call_log } from '@/db/schema';

// These loose-coupled correlation logs (no FK) accept either Db or Tx so callers
// can retain their existing transaction boundaries (FIX-R2-10). Tool-call logs
// and remote unknown-cost rows remain separate writes, not an atomic operation.
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
  /** DomainTool registry effect, including local control tools. Omit for legacy SDK auto-mirror. */
  effect?: 'read' | 'propose' | 'write' | 'control';
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

/**
 * YUK-1557 — record a remote tool call that has no provider-reported USD
 * price. The cost is explicitly `unknown` (never a fabricated zero) and the
 * synthetic task_run_id keeps the attempt-ledger uniqueness separate from the
 * model attempt row on the same run.
 */
export async function writeUnpricedToolCost(
  db: DbLike,
  entry: {
    taskRunId: string;
    provider: string;
    toolName: string;
    outcome: 'success' | 'failed_permanent' | 'failed_retryable';
    occurredAt?: Date;
  },
): Promise<void> {
  // Keep the original remote evidence construction before the ledger id and INSERT.
  const remoteCost = {
    entry_kind: 'attempt',
    task_run_id: `tool:${entry.taskRunId}:${entry.provider}:${entry.toolName}:${createId()}`,
    task_kind: 'remote_mcp_tool',
    provider: entry.provider,
    model: entry.toolName,
    cost: null,
    cost_basis: 'unknown',
    cost_ref: `unpriced:${entry.provider}/${entry.toolName}`,
    currency: 'USD',
    tokens_in: null,
    tokens_out: null,
    outcome: entry.outcome,
    occurred_at: entry.occurredAt ?? new Date(),
  };
  await db.insert(cost_ledger).values({
    id: createId(),
    ...remoteCost,
    outcome: remoteCost.outcome ?? 'success',
    pgboss_job_id: null,
  });
}
