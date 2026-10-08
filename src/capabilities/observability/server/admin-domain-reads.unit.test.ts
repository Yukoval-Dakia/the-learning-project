import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { GET as costGet } from '../api/admin-cost';
import { GET as failuresGet } from '../api/admin-failures';
import { GET as detailGet } from '../api/admin-run-detail';
import { GET as runsGet } from '../api/admin-runs';
import {
  AdminCostOptionsSchema,
  AdminFailuresOptionsSchema,
  AdminRunParamsSchema,
  AdminRunsOptionsSchema,
  loadAdminCost,
  loadAdminFailures,
  loadAdminRunDetail,
  loadAdminRuns,
  parseAdminCostQuery,
  parseAdminFailuresQuery,
  parseAdminRunsQuery,
} from '../public';
import { getAdminRunTimeline, listAdminRunsPage } from './ai-observability';
import type { ProviderCostAggregateRow } from './provider-cost-projection';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  read: vi.fn<typeof import('./provider-cost-projection').readProviderCostAggregates>(),
  results: [] as unknown[][],
}));
vi.mock('@/db/client', () => ({ db: { select: mocks.select } }));
vi.mock('./provider-cost-projection', () => ({
  readProviderCostAggregates: mocks.read,
  readProviderCostWindow: vi.fn(),
}));
vi.mock('./admin-config-facts', () => ({
  __resetAdminConfigRuntimeFactsForTests: vi.fn(),
  getAdminConfigRuntimeFacts: vi.fn(),
  setAdminConfigRuntimeFacts: vi.fn(),
}));
vi.mock('./admin-config-writer', () => ({ setAdminConfigWriter: vi.fn() }));
vi.mock('./config-effective-facts', () => ({ observabilityConfigEffectiveFacts: vi.fn() }));
vi.mock('./hub-sync', () => ({ readHubSyncHealth: vi.fn() }));

const now = new Date('2026-10-08T23:59:59.123Z');
const run = {
  id: 'rich_run',
  task_kind: 'AnalysisTask',
  provider: 'test',
  model: 'fixture',
  input_hash: 'hash:保留原件',
  status: 'failure',
  finish_reason: 'error',
  usage_json: {
    inputTokens: 12000,
    outputTokens: 789,
    extra: { ambiguity: [null, '证据'.repeat(100)] },
  },
  cost_usd: null,
  cost_basis: 'unknown',
  cost_ref: 'unpriced:fixture',
  error_message: 'Failed to parse nested evidence\n'.repeat(100),
  started_at: new Date(now.getTime() - 1500),
  finished_at: now,
};
const ledger = {
  id: 'ledger_1',
  task_run_id: run.id,
  task_kind: run.task_kind,
  provider: 'test',
  model: 'fixture',
  cost: null,
  currency: 'CNY',
  entry_kind: 'attempt',
  cost_basis: 'unknown',
  cost_ref: 'unpriced:fixture',
  tokens_in: 12000,
  tokens_out: 789,
  outcome: 'failure',
  pgboss_job_id: null,
  occurred_at: new Date(now.getTime() - 500),
};
const tool = {
  id: 'tool_1',
  tool_name: 'read_evidence',
  iteration: 3,
  latency_ms: 123.5,
  cost: 0,
  occurred_at: new Date(now.getTime() - 1000),
};
function queueDetail() {
  mocks.results.push([run], [ledger], [tool]);
}
function queueRuns() {
  mocks.results.push([run], [{ count: 1 }], [ledger], [{ task_run_id: run.id, count: 1 }]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.results = [];
  mocks.read.mockReset().mockResolvedValue([]);
  mocks.select.mockReset().mockImplementation(() => {
    const result = Promise.resolve(mocks.results.shift() ?? []);
    const query = Object.assign(result, {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      groupBy: () => query,
    });
    return query;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public admin options and legacy HTTP query behavior', () => {
  it.each(['', '0', '-1', '1.2', '2junk', 'NaN', 'Infinity'])(
    'rejects strict runs limit %s before reading',
    async (limit) => {
      const response = await runsGet(new Request(`http://localhost/api/admin/runs?limit=${limit}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'validation_error',
        message: `invalid limit: ${limit}`,
      });
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );
  it('keeps defaults, Number coercion, clamping, filters and status errors', async () => {
    expect(parseAdminRunsQuery()).toEqual({
      limit: 50,
      status: undefined,
      taskKind: undefined,
      cursor: undefined,
    });
    expect(
      parseAdminRunsQuery({ limit: '2e2', status: 'failure', task_kind: '', cursor: '' }),
    ).toEqual({ limit: 200, status: 'failure', taskKind: '', cursor: '' });
    expect(parseAdminRunsQuery({ limit: '999' }).limit).toBe(200);
    expect(AdminRunsOptionsSchema.parse({ limit: 999, status: 'running' })).toEqual({
      limit: 200,
      status: 'running',
    });
    const response = await runsGet(new Request('http://localhost/api/admin/runs?status=FAILED'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'validation_error',
      message: 'invalid run status: FAILED',
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, 30, 200],
    ['9'.repeat(400), 30, 50],
    ['', 30, 50],
    ['bogus', 30, 50],
    ['0', 30, 50],
    ['-2', 30, 50],
    ['7junk', 7, 7],
    ['2.9', 2, 2],
    ['999', 90, 200],
    ['1e2', 1, 1],
  ])('keeps cost/failure parseInt semantics for %s', async (value, days, limit) => {
    expect(parseAdminCostQuery({ days: value })).toEqual({ days });
    expect(parseAdminFailuresQuery({ limit: value })).toEqual({ limit });
    const query = value === undefined ? '' : `?days=${value}`;
    const cost = await costGet(new Request(`http://localhost/api/admin/cost${query}`));
    expect(await cost.json()).toEqual({ days_window: days, days: [], by_task: [], by_truth: [] });
    const failure = await failuresGet(
      new Request(
        `http://localhost/api/admin/failures${value === undefined ? '' : `?limit=${value}`}`,
      ),
    );
    expect(await failure.json()).toEqual({ clusters: [], limit });
  });
  it('shares typed normalization and detail validation with future RPC boundaries', async () => {
    expect(AdminCostOptionsSchema.safeParse({ days: '7' }).success).toBe(false);
    expect(AdminFailuresOptionsSchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(AdminCostOptionsSchema.parse({ days: 999 })).toEqual({ days: 999 });
    expect(AdminFailuresOptionsSchema.parse({})).toEqual({ limit: 200 });
    expect(AdminRunParamsSchema.safeParse({ id: '' }).success).toBe(false);
    await expect(loadAdminRunDetail(db, { id: '' })).rejects.toThrow();
    await expect(loadAdminRuns(db, { limit: 1.2 })).rejects.toThrow();
    expect(mocks.select).not.toHaveBeenCalled();
  });
});

describe('public shared DTO and actual HTTP consumers', () => {
  it('projects rich detail completely, omits undefined, retains nulls and matches old HTTP bytes', async () => {
    queueDetail();
    const raw = await getAdminRunTimeline(db, run.id);
    queueDetail();
    const supplied = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') return mocks.select;
        return Reflect.get(target, prop, receiver);
      },
    });
    const detail = await loadAdminRunDetail(supplied, { id: run.id });
    expect(JSON.stringify(detail)).toBe(JSON.stringify(raw));
    expect(detail?.run.started_at).toBe(run.started_at.toISOString());
    expect(detail?.run.finished_at).toBe(now.toISOString());
    expect(detail?.run.usage_json).toEqual(run.usage_json);
    expect(detail?.ledger).toEqual([{ ...ledger, occurred_at: ledger.occurred_at.toISOString() }]);
    expect(detail?.tool_calls).toEqual([{ ...tool, occurred_at: tool.occurred_at.toISOString() }]);
    expect(detail?.timeline.map((event) => [event.type, event.at])).toEqual([
      ['run_started', run.started_at.toISOString()],
      ['tool_call', tool.occurred_at.toISOString()],
      ['cost_ledger', ledger.occurred_at.toISOString()],
      ['run_finished', now.toISOString()],
    ]);
    for (const event of detail?.timeline ?? []) {
      expect(Object.values(event)).not.toContain(undefined);
      for (const value of Object.values(event)) expect(value).not.toBeInstanceOf(Date);
    }
    expect(detail?.timeline.find((event) => event.type === 'cost_ledger')).not.toHaveProperty(
      'cost',
    );
    expect(detail?.ledger[0].cost).toBeNull();
    queueDetail();
    expect(
      await (
        await detailGet(new Request('http://localhost/api/admin/runs/rich_run'), { id: run.id })
      ).text(),
    ).toBe(JSON.stringify(raw));
    expect(run.finished_at).toBe(now);
  });
  it('preserves the full collection envelope and unfinished null dates', async () => {
    queueRuns();
    const raw = await listAdminRunsPage(db);
    queueRuns();
    const result = await loadAdminRuns(db);
    const expectedBytes = JSON.stringify({
      ...raw,
      data: raw.rows,
      page: { limit: raw.limit, next_cursor: raw.next_cursor },
    });
    expect(JSON.stringify(result)).toBe(expectedBytes);
    expect(result.rows).toBe(result.data);
    queueRuns();
    expect(await (await runsGet(new Request('http://localhost/api/admin/runs'))).text()).toBe(
      expectedBytes,
    );
    mocks.results.push([{ ...run, status: 'running', finished_at: null }], [{ count: 1 }], [], []);
    expect((await loadAdminRuns(db)).rows[0].finished_at).toBeNull();
  });
  const malformedDetailParams: Record<string, string>[] = [{}, { id: '' }];
  it.each(malformedDetailParams)(
    'keeps direct handler malformed params %j generic without a DB read',
    async (params) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // Direct invocation intentionally supplies params the normal [id] route
      // cannot capture from this nonempty path segment.
      const response = await detailGet(
        new Request('http://localhost/api/admin/runs/placeholder'),
        params,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
      expect(log).toHaveBeenCalledOnce();
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it('preserves missing detail and cursor error bodies', async () => {
    expect(await loadAdminRunDetail(db, { id: 'absent' })).toBeNull();
    const missing = await detailGet(new Request('http://localhost/api/admin/runs/absent'), {
      id: 'absent',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', message: 'no run absent' });
    const cursor = await runsGet(new Request('http://localhost/api/admin/runs?cursor=bad'));
    expect(cursor.status).toBe(400);
    expect(await cursor.json()).toMatchObject({ error: 'invalid_cursor' });
  });
  it('projects failure cluster/sample timestamps and matches old bytes', async () => {
    const failures = Array.from({ length: 7 }, (_, index) => ({
      ...run,
      id: `failure_${index}`,
      started_at: new Date(now.getTime() - index),
      error_message: ' whitespace\n normalized   error ',
    }));
    mocks.results.push(failures);
    const result = await loadAdminFailures(db, { limit: 7 });
    expect(result).toMatchObject({
      limit: 7,
      clusters: [
        { count: 7, latest_at: now.toISOString(), error_prefix: 'whitespace normalized error' },
      ],
    });
    expect(result.clusters[0].samples).toHaveLength(5);
    expect(result.clusters[0].samples[4].started_at).toBe(
      new Date(now.getTime() - 4).toISOString(),
    );
    mocks.results.push(failures);
    expect(
      await (await failuresGet(new Request('http://localhost/api/admin/failures?limit=7'))).text(),
    ).toBe(JSON.stringify(result));
  });
  it('preserves the 80-character error prefix grouping and latest-time tie ordering', async () => {
    const prefix = '复杂失败证据'.repeat(20).slice(0, 80);
    mocks.results.push([
      { ...run, id: 'newer', error_message: 'separate failure', started_at: now },
      { ...run, id: 'a', error_message: `${prefix} first suffix` },
      { ...run, id: 'b', error_message: `${prefix} different suffix` },
      {
        ...run,
        id: 'older',
        error_message: 'older failure',
        started_at: new Date(now.getTime() - 9999),
      },
    ]);
    const result = await loadAdminFailures(db);
    expect(result.clusters.map((cluster) => [cluster.error_prefix, cluster.count])).toEqual([
      [prefix, 2],
      ['separate failure', 1],
      ['older failure', 1],
    ]);
  });

  it.each([
    [undefined, 30],
    [Number.NaN, 30],
    [Infinity, 30],
    [-1, 30],
    [0, 30],
    [0.5, 0],
    [3.9, 3],
    [999, 90],
  ])('keeps the raw cost days normalization exactly once for %s', async (days, expected) => {
    const result = await loadAdminCost(db, { days }, now);
    expect(result.days_window).toBe(expected);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
      db,
      new Date(now.getTime() - expected * 86_400_000),
    );
  });

  it('uses the injected DB and one explicit clock sample with existing aggregate semantics', async () => {
    const base: ProviderCostAggregateRow = {
      dimension: 'day',
      day: '2026-10-08',
      task_kind: null,
      currency: 'USD',
      entry_kind: null,
      cost_basis: null,
      cost_ref: null,
      cost: 0.75,
      reported_cost: 0.5,
      estimated_cost: 0.25,
      legacy_cost: 0,
      reported_attempts: 1,
      estimated_attempts: 1,
      unknown_attempts: 1,
      legacy_rows: 0,
      tokens_in: 12345,
      tokens_out: 789,
      calls: 3,
    };
    mocks.read.mockResolvedValue([
      base,
      { ...base, dimension: 'task', task_kind: 'AnalysisTask', currency: 'CNY' },
      {
        ...base,
        dimension: 'truth',
        currency: 'CNY',
        entry_kind: 'attempt',
        cost_basis: 'unknown',
        cost_ref: 'unpriced:fixture',
        cost: 0,
        unknown_attempts: 3,
      },
    ]);
    const supplied = new Proxy(db, {});
    const result = await loadAdminCost(supplied, { days: 7 }, now);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
      supplied,
      new Date(now.getTime() - 7 * 86_400_000),
    );
    expect(result.days[0]).toMatchObject({
      currency: 'USD',
      cost: 0.75,
      calls: 3,
      tokens_in: 12345,
    });
    expect(result.by_task[0].currency).toBe('CNY');
    expect(result.by_truth[0]).toMatchObject({
      cost: 0,
      cost_basis: 'unknown',
      unknown_attempts: 3,
      cost_ref: 'unpriced:fixture',
    });
    mocks.read.mockClear().mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 86_400_000));
      return [];
    });
    await costGet(new Request('http://localhost/api/admin/cost?days=7'));
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
      db,
      new Date(now.getTime() - 7 * 86_400_000),
    );
  });
  it.each(['runs', 'detail', 'cost', 'failures'])(
    'propagates %s domain errors and preserves HTTP sanitization',
    async (kind) => {
      const failure = new Error('private database credentials and SQL');
      mocks.select.mockImplementation(() => {
        throw failure;
      });
      mocks.read.mockRejectedValue(failure);
      const domain = () =>
        kind === 'runs'
          ? loadAdminRuns(db)
          : kind === 'detail'
            ? loadAdminRunDetail(db, { id: run.id })
            : kind === 'cost'
              ? loadAdminCost(db)
              : loadAdminFailures(db);
      await expect(domain()).rejects.toBe(failure);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const req = new Request('http://localhost/api/admin/runs');
      const response = await (kind === 'runs'
        ? runsGet(req)
        : kind === 'detail'
          ? detailGet(req, { id: run.id })
          : kind === 'cost'
            ? costGet(req)
            : failuresGet(req));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
    },
  );
  it('preserves typed API errors across the shared cost seam', async () => {
    mocks.read.mockRejectedValue(
      new ApiError('read_unavailable', 'Try later', 503, { 'Retry-After': '30' }),
    );
    const response = await costGet(new Request('http://localhost/api/admin/cost'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({ error: 'read_unavailable', message: 'Try later' });
  });
});
