import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { CostTodayResponseSchema } from '../api/admin-observability-contracts';
import { GET } from '../api/cost-today';
import { type TodayCost, loadTodayCost } from '../public';

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof import('./provider-cost-projection').readProviderCostAggregates>(),
  where: vi.fn<(condition: import('drizzle-orm').SQL) => Promise<{ n: number }[]>>(),
  from: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/db/client', () => ({ db: { select: mocks.select } }));
vi.mock('./provider-cost-projection', () => ({
  readProviderCostAggregates: mocks.read,
  readProviderCostWindow: vi.fn(),
}));
// Keep unrelated public exports out of this unit suite's initialization graph.
vi.mock('./admin-config-facts', () => ({
  __resetAdminConfigRuntimeFactsForTests: vi.fn(),
  getAdminConfigRuntimeFacts: vi.fn(),
  setAdminConfigRuntimeFacts: vi.fn(),
}));
vi.mock('./admin-config-writer', () => ({ setAdminConfigWriter: vi.fn() }));
vi.mock('./config-effective-facts', () => ({ observabilityConfigEffectiveFacts: vi.fn() }));
vi.mock('./hub-sync', () => ({ readHubSyncHealth: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T15:59:59.999Z'));
  mocks.read.mockReset().mockResolvedValue([]);
  mocks.where.mockReset().mockResolvedValue([{ n: 0 }]);
  mocks.from.mockReset().mockReturnValue({ where: mocks.where });
  mocks.select.mockReset().mockReturnValue({ from: mocks.from });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function emptyCost(now: Date, from: Date): TodayCost {
  return {
    window: {
      from: Math.floor(from.getTime() / 1000),
      to: Math.floor(now.getTime() / 1000),
      label: 'BJT today (from local midnight)',
    },
    today: {
      by_currency: [],
      tokens_in: 0,
      tokens_out: 0,
      ledger_rows: 0,
      unknown_attempts: 0,
      legacy_rows: 0,
      tool_calls: 0,
      by_truth: [],
      by_task: [],
    },
  };
}

describe('public Today cost loader and HTTP consumer', () => {
  it.each([
    ['2026-10-08T15:59:59.999Z', '2026-10-07T16:00:00.000Z'],
    ['2026-10-08T16:00:00.000Z', '2026-10-08T16:00:00.000Z'],
    ['2026-10-08T16:00:00.001Z', '2026-10-08T16:00:00.000Z'],
  ])('uses the injected database and BJT midnight at %s', async (nowIso, fromIso) => {
    const suppliedDb = new Proxy(db, {});
    const now = new Date(nowIso);
    const from = new Date(fromIso);
    const result = await loadTodayCost(suppliedDb, now);
    expect(result).toEqual(emptyCost(now, from));
    expect(CostTodayResponseSchema.parse(result)).toEqual(result);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(suppliedDb, from);
  });

  it('samples the default clock once even when the read crosses BJT midnight', async () => {
    const sampled = new Date();
    mocks.read.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-08T16:00:01.000Z'));
      return [];
    });
    expect(await loadTodayCost(db)).toEqual(
      emptyCost(sampled, new Date('2026-10-07T16:00:00.000Z')),
    );
  });

  it('returns the public DTO unchanged through GET with the same single clock sample', async () => {
    const expected = emptyCost(new Date(), new Date('2026-10-07T16:00:00.000Z'));
    mocks.where.mockResolvedValue([{ n: 7 }]);
    expected.today.tool_calls = 7;
    const response = await GET(new Request('http://localhost/api/cost/today'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(expected);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(db, new Date('2026-10-07T16:00:00Z'));
  });

  it.each(['projection', 'tool count'])(
    'rejects raw %s errors and sanitizes HTTP errors',
    async (stage) => {
      const failure = new Error('private database query detail: credential must not escape');
      if (stage === 'projection') mocks.read.mockRejectedValue(failure);
      else mocks.where.mockRejectedValue(failure);
      await expect(loadTodayCost(db)).rejects.toBe(failure);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const response = await GET(new Request('http://localhost/api/cost/today'));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
      expect(log).toHaveBeenCalledOnce();
    },
  );

  it('preserves ApiError status and headers at the HTTP boundary', async () => {
    const failure = new ApiError('read_unavailable', 'Read temporarily unavailable', 503, {
      'Retry-After': '30',
    });
    mocks.read.mockRejectedValue(failure);
    await expect(loadTodayCost(db)).rejects.toBe(failure);
    const response = await GET(new Request('http://localhost/api/cost/today'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({
      error: 'read_unavailable',
      message: 'Read temporarily unavailable',
    });
  });
});
