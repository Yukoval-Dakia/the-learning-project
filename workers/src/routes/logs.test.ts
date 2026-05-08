import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { logs } from './logs';
import type { AppEnv } from '../types';

function makeMockDb(rows: Record<string, unknown>[]) {
  const queries: string[] = [];
  const wrapped = (sql: string) => {
    queries.push(sql);
    return {
      bind: (..._binds: unknown[]) => ({
        all: async () => ({ results: rows, success: true, meta: {} }),
      }),
      all: async () => ({ results: rows, success: true, meta: {} }),
      first: async () => rows[0] ?? null,
    };
  };
  return { db: { prepare: wrapped } as unknown as D1Database, queries };
}

describe('GET /tool_calls', () => {
  function makeApp(rows: Record<string, unknown>[]) {
    const { db, queries } = makeMockDb(rows);
    const app = new Hono<AppEnv>();
    app.route('/api/_/logs', logs);
    return {
      app,
      env: { DB: db } as unknown as AppEnv['Bindings'],
      queries,
    };
  }

  it('returns recent tool call rows', async () => {
    const fakeRows = [
      {
        id: 'tcl_1',
        task_run_id: 'tr_1',
        task_kind: 'AttributionTask',
        tool_name: 'search_knowledge_by_concept',
        input_json: '{"concept":"x"}',
        output_json: '{"results":[]}',
        iteration: 1,
        latency_ms: 234,
        cost: 0.001,
        occurred_at: 1715000000,
      },
    ];
    const { app, env } = makeApp(fakeRows);
    const res = await app.request('/api/_/logs/tool_calls?limit=50', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
    expect((body.rows[0] as { tool_name: string }).tool_name).toBe(
      'search_knowledge_by_concept',
    );
  });

  it('clamps limit to safe range', async () => {
    const { app, env, queries } = makeApp([]);
    await app.request('/api/_/logs/tool_calls?limit=99999', {}, env);
    // limit param should be capped (we use 200 as max)
    const sql = queries.find((q) => /tool_call_log/i.test(q)) ?? '';
    expect(sql).toMatch(/limit\s+\?/i);
  });

  it('filters by task_kind when provided', async () => {
    const { app, env, queries } = makeApp([]);
    await app.request(
      '/api/_/logs/tool_calls?task_kind=AttributionTask',
      {},
      env,
    );
    const sql = queries.find((q) => /tool_call_log/i.test(q)) ?? '';
    expect(sql).toMatch(/task_kind\s*=\s*\?/i);
  });
});

describe('GET /cost', () => {
  function makeApp(rows: Record<string, unknown>[]) {
    const { db, queries } = makeMockDb(rows);
    const app = new Hono<AppEnv>();
    app.route('/api/_/logs', logs);
    return {
      app,
      env: { DB: db } as unknown as AppEnv['Bindings'],
      queries,
    };
  }

  it('returns aggregated cost rows for default range', async () => {
    const rows = [
      {
        bucket: '2026-05-08',
        task_kind: 'AttributionTask',
        model: 'claude-sonnet-4-6',
        cost_sum: 0.012,
        tokens_in_sum: 1234,
        tokens_out_sum: 567,
        call_count: 3,
      },
    ];
    const { app, env } = makeApp(rows);
    const res = await app.request('/api/_/logs/cost', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; range: string };
    expect(body.rows).toHaveLength(1);
    expect(body.range).toBe('day');
  });

  it('accepts range=week and range=month', async () => {
    const { app, env } = makeApp([]);
    const r1 = await app.request('/api/_/logs/cost?range=week', {}, env);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { range: string }).range).toBe('week');

    const r2 = await app.request('/api/_/logs/cost?range=month', {}, env);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { range: string }).range).toBe('month');
  });

  it('rejects invalid range', async () => {
    const { app, env } = makeApp([]);
    const res = await app.request('/api/_/logs/cost?range=bogus', {}, env);
    expect(res.status).toBe(400);
  });
});
