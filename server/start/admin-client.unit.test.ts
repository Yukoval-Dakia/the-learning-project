// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, TOKEN_STORAGE_KEY, subscribeAuthInvalidation } from '@/ui/lib/api';
import { startAdminClient } from './admin-client';
import {
  adminConjectures,
  adminCost,
  adminCoverage,
  adminDetail,
  adminFailures,
  adminRuns,
} from './admin-test-fixtures';

const rpc = vi.hoisted(() => ({
  getStartAdminRuns: vi.fn(),
  getStartAdminRunDetail: vi.fn(),
  getStartAdminCost: vi.fn(),
  getStartAdminFailures: vi.fn(),
  getStartAdminCoverage: vi.fn(),
  getStartAdminConjectureScores: vi.fn(),
}));
vi.mock('./admin-function', () => rpc);
const calls = [
  {
    call: () => startAdminClient.getRuns({ limit: '100' }),
    name: 'getStartAdminRuns',
    fixture: adminRuns,
    data: { limit: '100' },
  },
  {
    call: () => startAdminClient.getRunDetail({ id: adminDetail.run.id }),
    name: 'getStartAdminRunDetail',
    fixture: adminDetail,
    data: { id: adminDetail.run.id },
  },
  {
    call: () => startAdminClient.getCost({ days: '30' }),
    name: 'getStartAdminCost',
    fixture: adminCost,
    data: { days: '30' },
  },
  {
    call: () => startAdminClient.getFailures({ limit: '200' }),
    name: 'getStartAdminFailures',
    fixture: adminFailures,
    data: { limit: '200' },
  },
  {
    call: () => startAdminClient.getCoverage(),
    name: 'getStartAdminCoverage',
    fixture: adminCoverage,
    data: undefined,
  },
  {
    call: () => startAdminClient.getConjectureScores(),
    name: 'getStartAdminConjectureScores',
    fixture: adminConjectures,
    data: undefined,
  },
];
beforeEach(() => {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'fixture-token');
  vi.stubGlobal('fetch', vi.fn());
  for (const [name, fn] of Object.entries(rpc))
    fn.mockImplementation(async (options) => {
      const response = await options.fetch(`http://isolated.test/_serverFn/${name}`, {
        method: 'GET',
        headers: { 'x-tsr-serverFn': 'true' },
      });
      return response.json();
    });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
describe('admin RPC browser client', () => {
  it.each(calls)(
    'uses typed RPC for $name with full nullable/ISO fields and original authority',
    async ({ call, name, fixture, data }) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(fixture));
      expect(await call()).toEqual(fixture);
      const rpcCall = Object.entries(rpc).find(([key]) => key === name)?.[1];
      expect(rpcCall).toHaveBeenCalledOnce();
      expect(rpcCall?.mock.calls[0][0].data).toEqual(data);
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(String(url)).toContain(`/_serverFn/${name}`);
      expect(new Headers(init?.headers).get('x-internal-token')).toBe('fixture-token');
      expect(new Headers(init?.headers).get('x-tsr-serverFn')).toBe('true');
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    },
  );
  it.each(calls)('re-gates $name on 401 without HTTP fallback', async ({ call }) => {
    const invalidated = vi.fn();
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: 'unauthorized', message: 'Unauthorized' }, { status: 401 }),
    );
    await expect(call()).rejects.toBeInstanceOf(ApiAuthError);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    unsubscribe();
  });
  it.each(calls)(
    'retains the fenced epoch error for $name without clearing authority or falling back',
    async ({ call }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: 'contract_epoch_fenced', message: 'Epoch fenced' }, { status: 503 }),
      );
      await expect(call()).rejects.toMatchObject({ status: 503, code: 'contract_epoch_fenced' });
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('fixture-token');
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it('keeps independent detail 404 and rejects malformed RPC DTOs', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: 'not_found', message: 'no run missing' }, { status: 404 }),
    );
    await expect(startAdminClient.getRunDetail({ id: 'missing' })).rejects.toBeInstanceOf(ApiError);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ...adminDetail, run: { ...adminDetail.run, started_at: 'invalid' } }),
    );
    await expect(startAdminClient.getRunDetail({ id: adminDetail.run.id })).rejects.toThrow();
  });
});
