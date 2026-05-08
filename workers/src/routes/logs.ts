import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const logs = new Hono<AppEnv>();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

logs.get('/tool_calls', async (c) => {
  const rawLimit = Number.parseInt(c.req.query('limit') ?? `${DEFAULT_LIMIT}`, 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const taskKind = c.req.query('task_kind');

  const sql = taskKind
    ? `select id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at from tool_call_log where task_kind = ? order by occurred_at desc limit ?`
    : `select id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at from tool_call_log order by occurred_at desc limit ?`;

  const stmt = c.env.DB.prepare(sql);
  const bound = taskKind ? stmt.bind(taskKind, limit) : stmt.bind(limit);
  const result = await bound.all<Record<string, unknown>>();

  return c.json({ rows: result.results, limit });
});

type CostRange = 'day' | 'week' | 'month';

function rangeBucketExpr(range: CostRange): string {
  // SQLite date(...) with unixepoch occurred_at
  switch (range) {
    case 'day':
      return "date(occurred_at, 'unixepoch')";
    case 'week':
      return "strftime('%Y-W%W', occurred_at, 'unixepoch')";
    case 'month':
      return "strftime('%Y-%m', occurred_at, 'unixepoch')";
  }
}

logs.get('/cost', async (c) => {
  const rangeParam = c.req.query('range') ?? 'day';
  if (rangeParam !== 'day' && rangeParam !== 'week' && rangeParam !== 'month') {
    return c.json({ error: 'invalid_range', allowed: ['day', 'week', 'month'] }, 400);
  }
  const range: CostRange = rangeParam;

  const bucketExpr = rangeBucketExpr(range);
  const sql = `
    select
      ${bucketExpr} as bucket,
      task_kind,
      model,
      sum(cost) as cost_sum,
      sum(tokens_in) as tokens_in_sum,
      sum(tokens_out) as tokens_out_sum,
      count(*) as call_count
    from cost_ledger
    group by bucket, task_kind, model
    order by bucket desc, cost_sum desc
    limit 200
  `;

  const result = await c.env.DB.prepare(sql).all<Record<string, unknown>>();
  return c.json({ rows: result.results, range });
});
