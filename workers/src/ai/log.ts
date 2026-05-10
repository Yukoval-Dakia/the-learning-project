import type { D1Database } from '@cloudflare/workers-types';
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

export async function writeToolCallLog(db: D1Database, entry: ToolCallLogEntry): Promise<void> {
  const id = createId();
  const occurredAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      'insert into tool_call_log (id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      entry.task_run_id,
      entry.task_kind,
      entry.tool_name,
      JSON.stringify(entry.input_json),
      JSON.stringify(entry.output_json),
      entry.iteration,
      entry.latency_ms,
      entry.cost,
      occurredAt,
    )
    .run();
}

export interface CostLedgerEntry {
  task_kind: string;
  provider: string;
  model: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
}

export async function writeCostLedger(db: D1Database, entry: CostLedgerEntry): Promise<void> {
  const id = createId();
  const occurredAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      'insert into cost_ledger (id, task_kind, provider, model, cost, tokens_in, tokens_out, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      entry.task_kind,
      entry.provider,
      entry.model,
      entry.cost,
      entry.tokens_in,
      entry.tokens_out,
      occurredAt,
    )
    .run();
}
