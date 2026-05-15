import type { Db } from '@/db/client';
import { cost_ledger, tool_call_log } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';

export interface ToolCallLogEntry {
  task_run_id: string;
  task_kind: string;
  tool_name: string;
  input_json: unknown;
  output_json: unknown;
  iteration: number;
  latency_ms: number;
  cost: number;
}

export async function writeToolCallLog(db: Db, entry: ToolCallLogEntry): Promise<void> {
  await db.insert(tool_call_log).values({
    id: createId(),
    task_run_id: entry.task_run_id,
    task_kind: entry.task_kind,
    tool_name: entry.tool_name,
    input_json: entry.input_json as Record<string, unknown>,
    output_json: entry.output_json as Record<string, unknown>,
    iteration: entry.iteration,
    latency_ms: entry.latency_ms,
    cost: entry.cost,
    occurred_at: new Date(),
  });
}

export interface CostLedgerEntry {
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

export async function writeCostLedger(db: Db, entry: CostLedgerEntry): Promise<void> {
  await db.insert(cost_ledger).values({
    id: createId(),
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
