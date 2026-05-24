import type { Db, Tx } from '@/db/client';
import { ai_task_runs, cost_ledger, tool_call_log } from '@/db/schema';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

export type AdminRunStatus = 'running' | 'success' | 'failure';

export interface AdminRunListOpts {
  limit?: number;
  status?: AdminRunStatus;
  taskKind?: string;
}

export interface AdminRunListRow {
  id: string;
  task_kind: string;
  provider: string;
  model: string;
  input_hash: string;
  status: string;
  finish_reason: string | null;
  usage_json: { inputTokens: number; outputTokens: number };
  cost_usd: number;
  error_message: string | null;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  ledger_cost_usd: number;
  ledger_rows: number;
  tool_call_count: number;
  pgboss_job_ids: string[];
}

export interface AdminRunListPage {
  rows: AdminRunListRow[];
  limit: number;
  total: number;
  truncated: boolean;
}

export interface AdminRunTimelineEvent {
  type: 'run_started' | 'tool_call' | 'cost_ledger' | 'run_finished';
  at: Date;
  label: string;
  id?: string;
  tool_name?: string;
  iteration?: number;
  latency_ms?: number;
  cost?: number;
  tokens_in?: number;
  tokens_out?: number;
  outcome?: string;
  pgboss_job_id?: string | null;
}

export interface AdminRunTimeline {
  run: AdminRunListRow;
  ledger: Array<typeof cost_ledger.$inferSelect>;
  tool_calls: Array<typeof tool_call_log.$inferSelect>;
  timeline: AdminRunTimelineEvent[];
}

export interface AdminCostDayRow {
  day: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
}

export interface AdminCostTaskRow {
  task_kind: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
}

export interface AdminCostResponse {
  days_window: number;
  days: AdminCostDayRow[];
  by_task: AdminCostTaskRow[];
}

export interface AdminFailureSample {
  id: string;
  task_kind: string;
  model: string;
  started_at: Date;
  error_message: string | null;
}

export interface AdminFailureCluster {
  key: string;
  finish_reason: string;
  error_prefix: string;
  count: number;
  latest_at: Date;
  samples: AdminFailureSample[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const FAILURE_PREFIX_LENGTH = 80;

function normalizeLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return fallback;
  return Math.min(Math.trunc(limit), MAX_LIMIT);
}

function normalizeDays(days: number | undefined): number {
  if (!Number.isFinite(days) || !days || days <= 0) return 30;
  return Math.min(Math.trunc(days), 90);
}

function durationMs(startedAt: Date, finishedAt: Date | null): number | null {
  if (!finishedAt) return null;
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function errorPrefix(message: string | null): string {
  const normalized = (message ?? 'no error message').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, FAILURE_PREFIX_LENGTH);
}

async function ledgerRowsByRunId(
  db: DbLike,
  runIds: string[],
): Promise<Map<string, Array<typeof cost_ledger.$inferSelect>>> {
  const out = new Map<string, Array<typeof cost_ledger.$inferSelect>>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select()
    .from(cost_ledger)
    .where(inArray(cost_ledger.task_run_id, runIds))
    .orderBy(asc(cost_ledger.occurred_at));
  for (const row of rows) {
    if (!row.task_run_id) continue;
    const bucket = out.get(row.task_run_id) ?? [];
    bucket.push(row);
    out.set(row.task_run_id, bucket);
  }
  return out;
}

async function toolCountsByRunId(db: DbLike, runIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({
      task_run_id: tool_call_log.task_run_id,
      count: sql<number>`count(*)::int`,
    })
    .from(tool_call_log)
    .where(inArray(tool_call_log.task_run_id, runIds))
    .groupBy(tool_call_log.task_run_id);
  for (const row of rows) out.set(row.task_run_id, row.count);
  return out;
}

function projectRun(
  row: typeof ai_task_runs.$inferSelect,
  ledgerRows: Array<typeof cost_ledger.$inferSelect>,
  toolCallCount: number,
): AdminRunListRow {
  const ledgerCost = ledgerRows.reduce((sum, entry) => sum + entry.cost, 0);
  return {
    id: row.id,
    task_kind: row.task_kind,
    provider: row.provider,
    model: row.model,
    input_hash: row.input_hash,
    status: row.status,
    finish_reason: row.finish_reason,
    usage_json: row.usage_json,
    cost_usd: row.cost_usd ?? ledgerCost,
    error_message: row.error_message,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: durationMs(row.started_at, row.finished_at),
    ledger_cost_usd: ledgerCost,
    ledger_rows: ledgerRows.length,
    tool_call_count: toolCallCount,
    pgboss_job_ids: [
      ...new Set(
        ledgerRows
          .map((entry) => entry.pgboss_job_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ],
  };
}

export async function listAdminRuns(
  db: DbLike,
  opts: AdminRunListOpts = {},
): Promise<AdminRunListRow[]> {
  return (await listAdminRunsPage(db, opts)).rows;
}

export async function listAdminRunsPage(
  db: DbLike,
  opts: AdminRunListOpts = {},
): Promise<AdminRunListPage> {
  const conditions = [];
  if (opts.status) conditions.push(eq(ai_task_runs.status, opts.status));
  if (opts.taskKind) conditions.push(eq(ai_task_runs.task_kind, opts.taskKind));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = normalizeLimit(opts.limit);

  const rows = await db
    .select()
    .from(ai_task_runs)
    .where(where)
    .orderBy(desc(ai_task_runs.started_at), desc(ai_task_runs.id))
    .limit(limit);

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ai_task_runs)
    .where(where);
  const total = totalRows[0]?.count ?? rows.length;

  const runIds = rows.map((row) => row.id);
  const ledgerByRun = await ledgerRowsByRunId(db, runIds);
  const toolCounts = await toolCountsByRunId(db, runIds);

  return {
    rows: rows.map((row) =>
      projectRun(row, ledgerByRun.get(row.id) ?? [], toolCounts.get(row.id) ?? 0),
    ),
    limit,
    total,
    truncated: total > rows.length,
  };
}

export async function getAdminRunTimeline(
  db: DbLike,
  id: string,
): Promise<AdminRunTimeline | null> {
  const rows = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, id)).limit(1);
  const runRow = rows[0];
  if (!runRow) return null;

  const ledger = await db
    .select()
    .from(cost_ledger)
    .where(eq(cost_ledger.task_run_id, id))
    .orderBy(asc(cost_ledger.occurred_at), asc(cost_ledger.id));
  const toolCalls = await db
    .select()
    .from(tool_call_log)
    .where(eq(tool_call_log.task_run_id, id))
    .orderBy(asc(tool_call_log.occurred_at), asc(tool_call_log.iteration), asc(tool_call_log.id));

  const timeline: AdminRunTimelineEvent[] = [
    {
      type: 'run_started',
      at: runRow.started_at,
      label: `${runRow.task_kind} started`,
      id: runRow.id,
    },
    ...toolCalls.map(
      (entry): AdminRunTimelineEvent => ({
        type: 'tool_call',
        at: entry.occurred_at,
        label: entry.tool_name,
        id: entry.id,
        tool_name: entry.tool_name,
        iteration: entry.iteration,
        latency_ms: entry.latency_ms,
        cost: entry.cost,
      }),
    ),
    ...ledger.map(
      (entry): AdminRunTimelineEvent => ({
        type: 'cost_ledger',
        at: entry.occurred_at,
        label: entry.outcome,
        id: entry.id,
        cost: entry.cost,
        tokens_in: entry.tokens_in,
        tokens_out: entry.tokens_out,
        outcome: entry.outcome,
        pgboss_job_id: entry.pgboss_job_id,
      }),
    ),
  ];
  if (runRow.finished_at) {
    timeline.push({
      type: 'run_finished',
      at: runRow.finished_at,
      label: runRow.status,
      id: runRow.id,
      outcome: runRow.finish_reason ?? runRow.status,
      cost: runRow.cost_usd ?? undefined,
    });
  }
  timeline.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      (a.id ?? '').localeCompare(b.id ?? '') ||
      a.type.localeCompare(b.type),
  );

  return {
    run: projectRun(runRow, ledger, toolCalls.length),
    ledger,
    tool_calls: toolCalls,
    timeline,
  };
}

export async function getAdminCost(
  db: DbLike,
  opts: { days?: number } = {},
): Promise<AdminCostResponse> {
  const days = normalizeDays(opts.days);
  const from = new Date(Date.now() - days * 86_400_000);

  const dailyRows = await db
    .select({
      day: sql<string>`date_trunc('day', ${cost_ledger.occurred_at})::date::text`,
      cost: sql<number>`COALESCE(SUM(${cost_ledger.cost}), 0)::real`,
      tokens_in: sql<number>`COALESCE(SUM(${cost_ledger.tokens_in}), 0)::int`,
      tokens_out: sql<number>`COALESCE(SUM(${cost_ledger.tokens_out}), 0)::int`,
      calls: sql<number>`COUNT(*)::int`,
    })
    .from(cost_ledger)
    .where(gte(cost_ledger.occurred_at, from))
    .groupBy(sql`1`)
    .orderBy(sql`1 asc`);

  const taskRows = await db
    .select({
      task_kind: cost_ledger.task_kind,
      cost: sql<number>`COALESCE(SUM(${cost_ledger.cost}), 0)::real`,
      tokens_in: sql<number>`COALESCE(SUM(${cost_ledger.tokens_in}), 0)::int`,
      tokens_out: sql<number>`COALESCE(SUM(${cost_ledger.tokens_out}), 0)::int`,
      calls: sql<number>`COUNT(*)::int`,
    })
    .from(cost_ledger)
    .where(gte(cost_ledger.occurred_at, from))
    .groupBy(cost_ledger.task_kind)
    .orderBy(desc(sql`SUM(${cost_ledger.cost})`), cost_ledger.task_kind);

  return { days_window: days, days: dailyRows, by_task: taskRows };
}

export async function getAdminFailureClusters(
  db: DbLike,
  opts: { limit?: number } = {},
): Promise<AdminFailureCluster[]> {
  const rows = await db
    .select()
    .from(ai_task_runs)
    .where(eq(ai_task_runs.status, 'failure'))
    .orderBy(desc(ai_task_runs.started_at), desc(ai_task_runs.id))
    .limit(normalizeLimit(opts.limit));

  const byKey = new Map<string, AdminFailureCluster>();
  for (const row of rows) {
    const finishReason = row.finish_reason ?? 'unknown';
    const prefix = errorPrefix(row.error_message);
    const key = `${finishReason}::${prefix}`;
    const sample: AdminFailureSample = {
      id: row.id,
      task_kind: row.task_kind,
      model: row.model,
      started_at: row.started_at,
      error_message: row.error_message,
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        finish_reason: finishReason,
        error_prefix: prefix,
        count: 1,
        latest_at: row.started_at,
        samples: [sample],
      });
      continue;
    }
    existing.count += 1;
    if (row.started_at > existing.latest_at) existing.latest_at = row.started_at;
    if (existing.samples.length < 5) existing.samples.push(sample);
  }

  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || b.latest_at.getTime() - a.latest_at.getTime(),
  );
}
