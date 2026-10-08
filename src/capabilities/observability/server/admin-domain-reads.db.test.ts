import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadAdminCost,
  loadAdminFailures,
  loadAdminRunDetail,
  loadAdminRuns,
  parseAdminFailuresQuery,
} from '@/capabilities/observability/public';
import { type Db, type Tx, db as singletonDb } from '@/db/client';
import { ai_task_runs, cost_ledger, provider_attempt, tool_call_log } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as costGet } from '../api/admin-cost';
import { GET as failuresGet } from '../api/admin-failures';
import { GET as detailGet } from '../api/admin-run-detail';
import { GET as runsGet } from '../api/admin-runs';
import {
  getAdminFailureClusters,
  getAdminRunTimeline,
  listAdminRunsPage,
} from './ai-observability';

const now = new Date('2026-10-08T23:59:59.123Z');
function run(
  id: string,
  overrides: Partial<typeof ai_task_runs.$inferInsert> = {},
): typeof ai_task_runs.$inferInsert {
  return {
    id,
    task_kind: 'AnalysisTask',
    provider: 'test',
    model: 'fixture',
    input_hash: `hash_${id}`,
    status: 'failure',
    finish_reason: 'error',
    usage_json: { inputTokens: 12000, outputTokens: 789 },
    cost_usd: null,
    cost_basis: 'unknown',
    cost_ref: 'unpriced:fixture',
    error_message: 'Ambiguous evidence\n'.repeat(100),
    started_at: new Date(now.getTime() - 1500),
    finished_at: now,
    ...overrides,
  };
}
function ledger(
  id: string,
  cost: number | null,
  basis: 'reported' | 'estimated' | 'unknown' | null,
  currency = 'USD',
  at = now,
): typeof cost_ledger.$inferInsert {
  return {
    id,
    task_run_id: `run_${id}`,
    task_kind: 'AnalysisTask',
    provider: 'test',
    model: 'fixture',
    cost,
    currency,
    entry_kind: basis === null ? 'legacy' : 'attempt',
    cost_basis: basis,
    cost_ref: basis === null ? null : `fixture:${id}`,
    tokens_in: 100,
    tokens_out: 20,
    outcome: 'failure',
    pgboss_job_id: basis === null ? 'job_legacy' : null,
    occurred_at: at,
  };
}
function attempt(
  id: string,
  basis: 'reported' | 'estimated' | 'unknown',
  amount: number | null,
): typeof provider_attempt.$inferInsert {
  return {
    attempt_id: id,
    operation_id: '00000000-0000-4000-8000-000000001381',
    attempt_kind: 'wire',
    provider: 'glm',
    model: 'glm-fixture',
    lane_id: 'glm.memory-reconcile',
    protocol: 'http',
    endpoint_class: 'openai-compatible.chat-completions',
    caller: 'worker',
    operation_kind: 'AnalysisTask',
    terminal_status: 'succeeded',
    terminal_reason: 'provider_response_accepted',
    wire_count: 1,
    usage_json: {
      basis: 'reported',
      unit: 'tokens',
      input: 200,
      output: 40,
      total: 240,
      source: 'provider_response',
    },
    cost_basis: basis,
    cost_amount: amount,
    cost_currency: 'CNY',
    cost_source: `fixture:provider_${basis}`,
    started_at: now,
    provider_start_reserved_at: now,
    finished_at: now,
  };
}
async function richDetail(db: Db | Tx) {
  await db.insert(ai_task_runs).values(run('rich_run'));
  await db.insert(cost_ledger).values([
    {
      ...ledger('unknown', null, 'unknown', 'USD', new Date(now.getTime() - 500)),
      task_run_id: 'rich_run',
    },
    { ...ledger('legacy', 999, null, 'CNY'), task_run_id: 'rich_run' },
  ]);
  await db.insert(tool_call_log).values({
    id: 'tool_rich',
    task_run_id: 'rich_run',
    task_kind: 'AnalysisTask',
    tool_name: 'read_evidence',
    input_json: {
      text: '保留条件、歧义和失败证据。'.repeat(200),
      nested: { alternatives: [null, false, 'long'] },
    },
    output_json: { records: [{ id: 'evidence', warnings: ['ambiguous condition'] }] },
    iteration: 3,
    latency_ms: 123.5,
    cost: 0,
    occurred_at: new Date(now.getTime() - 1000),
  });
}
// Compare full public-table contents rather than an allowlisted count of source rows.
async function publicSnapshot(db: Db | Tx) {
  const tables = await db.execute<{ table_name: string }>(sql`
    select tablename as table_name from pg_tables where schemaname = 'public' order by tablename
  `);
  const snapshot: Record<string, string> = {};
  for (const { table_name } of tables) {
    const rows = await db.execute<{ digest: string }>(sql`
      select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest
      from ${sql.identifier(table_name)} t
    `);
    snapshot[table_name] = rows[0].digest;
  }
  return snapshot;
}
function assertWire(value: unknown): void {
  expect(value).not.toBeInstanceOf(Date);
  expect(value).not.toBeUndefined();
  if (Array.isArray(value)) for (const entry of value) assertWire(entry);
  else if (value !== null && typeof value === 'object')
    for (const entry of Object.values(value)) assertWire(entry);
}

beforeEach(resetDb);
afterEach(() => {
  vi.useRealTimers();
});

describe('public admin reads on the caller database', () => {
  it('reads nonzero uncommitted Tx data, leaves every public table unchanged and loses all data on rollback', async () => {
    const rollback = new Error('intentional rollback');
    await expect(
      testDb().transaction(async (tx) => {
        await richDetail(tx);
        const before = await publicSnapshot(tx);
        const runs = await loadAdminRuns(tx, { status: 'failure', taskKind: 'AnalysisTask' });
        const detail = await loadAdminRunDetail(tx, { id: 'rich_run' });
        const cost = await loadAdminCost(tx, { days: 7 }, now);
        const failures = await loadAdminFailures(tx);
        expect(runs.total).toBe(1);
        expect(detail?.tool_calls).toHaveLength(1);
        expect(detail?.ledger).toHaveLength(2);
        expect(cost.days).toHaveLength(2);
        expect(failures.clusters[0].count).toBe(1);
        for (const value of [runs, detail, cost, failures]) assertWire(value);
        expect((await loadAdminRuns(singletonDb)).total).toBe(0);
        expect(await loadAdminRunDetail(singletonDb, { id: 'rich_run' })).toBeNull();
        expect((await loadAdminCost(singletonDb, {}, now)).days).toEqual([]);
        expect((await loadAdminFailures(singletonDb)).clusters).toEqual([]);
        expect(await publicSnapshot(tx)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await loadAdminRuns(testDb())).total).toBe(0);
    expect(await loadAdminRunDetail(testDb(), { id: 'rich_run' })).toBeNull();
    expect((await loadAdminCost(testDb(), {}, now)).days).toEqual([]);
    expect((await loadAdminFailures(testDb())).clusters).toEqual([]);
  });

  it('keeps filters, stable same-time cursors, total across pages and complete HTTP collection bytes', async () => {
    const db = testDb();
    await db
      .insert(ai_task_runs)
      .values([
        ...['a', 'b', 'c', 'd', 'e'].map((id) => run(id)),
        run('other_kind', { task_kind: 'OtherTask' }),
        run('success', { status: 'success', finish_reason: 'stop' }),
      ]);
    const options = { status: 'failure', taskKind: 'AnalysisTask', limit: 2 } satisfies Parameters<
      typeof loadAdminRuns
    >[1];
    const first = await loadAdminRuns(db, options);
    expect(first.rows.map((row) => row.id)).toEqual(['e', 'd']);
    expect(first).toMatchObject({ total: 5, truncated: true, limit: 2 });
    expect(first.next_cursor).toBeTypeOf('string');
    const second = await loadAdminRuns(db, { ...options, cursor: first.next_cursor ?? undefined });
    const third = await loadAdminRuns(db, { ...options, cursor: second.next_cursor ?? undefined });
    expect(second.rows.map((row) => row.id)).toEqual(['c', 'b']);
    expect(third.rows.map((row) => row.id)).toEqual(['a']);
    expect(second.total).toBe(5);
    expect(third).toMatchObject({ total: 5, next_cursor: null, truncated: false });
    expect((await loadAdminRuns(db, { status: 'running' })).total).toBe(0);
    const raw = await listAdminRunsPage(db, options);
    expect(JSON.stringify(first)).toBe(
      JSON.stringify({
        ...raw,
        data: raw.rows,
        page: { limit: raw.limit, next_cursor: raw.next_cursor },
      }),
    );
    const http = await runsGet(
      new Request('http://localhost/api/admin/runs?status=failure&task_kind=AnalysisTask&limit=2'),
    );
    expect(http.status).toBe(200);
    expect(await http.text()).toBe(JSON.stringify(first));
    await expect(loadAdminRuns(db, { cursor: 'bad_cursor' })).rejects.toMatchObject({
      code: 'invalid_cursor',
      status: 400,
    });
  });

  it('keeps rich raw reader compatibility and exact HTTP detail bytes, including null/undefined semantics', async () => {
    const db = testDb();
    await richDetail(db);
    const raw = await getAdminRunTimeline(db, 'rich_run');
    expect(raw?.run.started_at).toBeInstanceOf(Date);
    expect(raw?.ledger[0].occurred_at).toBeInstanceOf(Date);
    const dto = await loadAdminRunDetail(db, { id: 'rich_run' });
    assertWire(dto);
    expect(JSON.stringify(dto)).toBe(JSON.stringify(raw));
    expect(dto?.run).toMatchObject({
      cost_usd: null,
      ledger_cost_usd: null,
      tool_call_count: 1,
      ledger_rows: 2,
      pgboss_job_ids: ['job_legacy'],
      finished_at: now.toISOString(),
      duration_ms: 1500,
    });
    expect(dto?.ledger[0]).toMatchObject({
      currency: 'USD',
      cost: null,
      cost_basis: 'unknown',
      cost_ref: 'fixture:unknown',
    });
    expect(dto?.tool_calls[0].occurred_at).toBe(new Date(now.getTime() - 1000).toISOString());
    expect(
      dto?.timeline.find((event) => event.type === 'cost_ledger' && event.id === 'unknown'),
    ).not.toHaveProperty('cost');
    const http = await detailGet(new Request('http://localhost/api/admin/runs/rich_run'), {
      id: 'rich_run',
    });
    expect(await http.text()).toBe(JSON.stringify(raw));
    expect(await loadAdminRunDetail(db, { id: 'absent' })).toBeNull();
    const missing = await detailGet(new Request('http://localhost/api/admin/runs/absent'), {
      id: 'absent',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', message: 'no run absent' });
  });

  it('retains mixed USD/CNY truth, known zero, unknown, legacy, tokens/calls and exact lower-bound-only cost window', async () => {
    const db = testDb();
    const from = new Date(now.getTime() - 7 * 86_400_000);
    await db.insert(cost_ledger).values([
      ledger('reported', 0.5, 'reported'),
      ledger('estimated', 0.25, 'estimated'),
      ledger('unknown', null, 'unknown'),
      ledger('known_zero', 0, 'reported'),
      ledger('legacy_usd', 0.125, null),
      ledger('legacy_cny', 0.25, null, 'CNY'),
      ledger('at_boundary', 1, null, 'USD', from),
      ledger('before_boundary', 128, null, 'USD', new Date(from.getTime() - 1)),
      ledger('future', 2, null, 'USD', new Date(now.getTime() + 86_400_000)),
      {
        ...ledger('linked_duplicate', 999, null, 'CNY'),
        task_run_id: '00000000-0000-4000-8000-000000001382',
      },
    ]);
    await db
      .insert(provider_attempt)
      .values([
        attempt('00000000-0000-4000-8000-000000001382', 'reported', 0.75),
        attempt('00000000-0000-4000-8000-000000001383', 'estimated', 1.5),
        attempt('00000000-0000-4000-8000-000000001384', 'unknown', null),
      ]);
    const result = await loadAdminCost(db, { days: 7 }, now);
    expect(result.days_window).toBe(7);
    expect(result.by_task).toEqual(
      expect.arrayContaining([
        {
          task_kind: 'AnalysisTask',
          currency: 'USD',
          cost: 3.875,
          reported_cost: 0.5,
          estimated_cost: 0.25,
          legacy_cost: 3.125,
          reported_attempts: 2,
          estimated_attempts: 1,
          unknown_attempts: 1,
          legacy_rows: 3,
          tokens_in: 700,
          tokens_out: 140,
          calls: 7,
        },
        {
          task_kind: 'AnalysisTask',
          currency: 'CNY',
          cost: 2.5,
          reported_cost: 0.75,
          estimated_cost: 1.5,
          legacy_cost: 0.25,
          reported_attempts: 1,
          estimated_attempts: 1,
          unknown_attempts: 1,
          legacy_rows: 1,
          tokens_in: 700,
          tokens_out: 140,
          calls: 4,
        },
      ]),
    );
    expect(result.by_truth).toHaveLength(9);
    expect(result.by_truth).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: 'USD',
          cost_basis: 'unknown',
          cost: 0,
          unknown_attempts: 1,
          cost_ref: 'fixture:unknown',
        }),
        expect.objectContaining({
          currency: 'USD',
          cost_basis: 'reported',
          cost: 0,
          cost_ref: 'fixture:known_zero',
          calls: 1,
        }),
        expect.objectContaining({
          currency: 'CNY',
          cost_basis: 'unknown',
          cost: 0,
          unknown_attempts: 1,
        }),
        expect.objectContaining({
          currency: 'CNY',
          entry_kind: 'legacy',
          cost_basis: null,
          cost_ref: null,
          cost: 0.25,
        }),
      ]),
    );
    expect(result.days.map((row) => `${row.day}:${row.currency}`)).toEqual([
      '2026-10-01:USD',
      '2026-10-08:CNY',
      '2026-10-08:USD',
      '2026-10-09:USD',
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const http = await costGet(new Request('http://localhost/api/admin/cost?days=7'));
    expect(await http.text()).toBe(JSON.stringify(result));
  });

  it('clusters only the recent bounded failure rows with stable ordering and five samples', async () => {
    const db = testDb();
    await db.insert(ai_task_runs).values([
      ...Array.from({ length: 8 }, (_, index) =>
        run(`repeat_${index}`, {
          started_at: new Date(now.getTime() - index),
          error_message: index % 2 ? ' repeated\n error ' : 'repeated error',
        }),
      ),
      run('second', {
        started_at: new Date(now.getTime() - 10),
        finish_reason: null,
        error_message: null,
      }),
      run('old', { started_at: new Date(now.getTime() - 1000), error_message: 'old failure' }),
      run('success', { status: 'success' }),
      run('running', { status: 'running', finished_at: null }),
    ]);
    const result = await loadAdminFailures(db, { limit: 9 });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]).toMatchObject({
      key: 'error::repeated error',
      count: 8,
      latest_at: now.toISOString(),
      error_prefix: 'repeated error',
    });
    expect(result.clusters[0].samples.map((row) => row.id)).toEqual([
      'repeat_0',
      'repeat_1',
      'repeat_2',
      'repeat_3',
      'repeat_4',
    ]);
    expect(result.clusters[1]).toMatchObject({ key: 'unknown::no error message', count: 1 });
    assertWire(result);
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({ clusters: await getAdminFailureClusters(db, { limit: 9 }), limit: 9 }),
    );
    const http = await failuresGet(new Request('http://localhost/api/admin/failures?limit=9junk'));
    expect(await http.text()).toBe(JSON.stringify(result));
    expect(
      (await loadAdminFailures(db, parseAdminFailuresQuery({ limit: '1' }))).clusters[0].count,
    ).toBe(1);
    expect((await loadAdminFailures(db)).clusters.map((cluster) => cluster.count)).toEqual([
      8, 1, 1,
    ]);
  });
});
