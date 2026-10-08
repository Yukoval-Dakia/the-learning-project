import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartAdmin } from './admin-read';
import type { createStartAdminReader } from './admin-reader';
import {
  adminConjectures,
  adminCost,
  adminCoverage,
  adminDetail,
  adminFailures,
  adminRuns,
} from './admin-test-fixtures';

const seams = vi.hoisted(() => ({
  dbImport: vi.fn(),
  domainImport: vi.fn(),
  runs: vi.fn<typeof import('@/capabilities/observability/public').loadAdminRuns>(),
  detail: vi.fn<typeof import('@/capabilities/observability/public').loadAdminRunDetail>(),
  cost: vi.fn<typeof import('@/capabilities/observability/public').loadAdminCost>(),
  failures: vi.fn<typeof import('@/capabilities/observability/public').loadAdminFailures>(),
  coverage: vi.fn<typeof import('@/capabilities/observability/public').loadCoverageLattice>(),
  conjectures: vi.fn<typeof import('@/capabilities/observability/public').loadConjectureScores>(),
}));
vi.mock('@/db/client', () => ({
  get db() {
    seams.dbImport();
    return { name: 'injected-unit-db' };
  },
}));
vi.mock('@/capabilities/observability/public', async (importOriginal) => {
  seams.domainImport();
  const original = await importOriginal<typeof import('@/capabilities/observability/public')>();
  return {
    ...original,
    loadAdminRuns: seams.runs,
    loadAdminRunDetail: seams.detail,
    loadAdminCost: seams.cost,
    loadAdminFailures: seams.failures,
    loadCoverageLattice: seams.coverage,
    loadConjectureScores: seams.conjectures,
  };
});
type Reader = Awaited<ReturnType<typeof createStartAdminReader>>;
const operations: Array<(reader: Reader) => Promise<unknown>> = [
  (r) => r.getRuns({ limit: '100' }),
  (r) => r.getRunDetail({ id: adminDetail.run.id }),
  (r) => r.getCost({ days: '30' }),
  (r) => r.getFailures({ limit: '200' }),
  (r) => r.getCoverage(),
  (r) => r.getConjectureScores(),
];
const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/admin', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
const allowed = () => ({ api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }) });
async function denial(call: Promise<unknown>, status: number) {
  const result: unknown = await call.catch((error: unknown) => error);
  if (!(result instanceof Response)) throw new Error('Expected shaped HTTP response');
  expect(result.status).toBe(status);
  return result.json();
}
beforeEach(() => {
  vi.stubEnv('INTERNAL_TOKEN', 'unit-admin-token');
  vi.clearAllMocks();
  for (const load of [
    seams.runs,
    seams.detail,
    seams.cost,
    seams.failures,
    seams.coverage,
    seams.conjectures,
  ])
    load.mockReset();
  seams.runs.mockResolvedValue(adminRuns);
  seams.detail.mockResolvedValue(adminDetail);
  seams.cost.mockResolvedValue(adminCost);
  seams.failures.mockResolvedValue(adminFailures);
  seams.coverage.mockResolvedValue(adminCoverage);
  seams.conjectures.mockResolvedValue(adminConjectures);
});
afterEach(() => vi.unstubAllEnvs());

describe('Start admin auth before imports, validation and database access', () => {
  it.each([undefined, '', 'wrong', 'unit-admin-token-extra'])(
    'denies token %s for every read',
    async (token) => {
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const context = { api: buildHonoApp([], { epochGate }) };
      for (const operation of [...operations, (r: Reader) => r.getRuns({ limit: 'invalid' })]) {
        const called = vi.fn(operation);
        await denial(runAuthenticatedStartAdmin(context, request(token), called), 401);
        expect(called).not.toHaveBeenCalled();
      }
      expect(epochGate).not.toHaveBeenCalled();
      expect(seams.dbImport).not.toHaveBeenCalled();
      expect(seams.domainImport).not.toHaveBeenCalled();
      for (const load of [
        seams.runs,
        seams.detail,
        seams.cost,
        seams.failures,
        seams.coverage,
        seams.conjectures,
      ])
        expect(load).not.toHaveBeenCalled();
    },
  );
  it('keeps the canonical fenced 503 and calls no reader even for invalid input', async () => {
    const context = {
      api: buildHonoApp([], {
        epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
      }),
    };
    for (const operation of [...operations, (r: Reader) => r.getRunDetail({ id: '' })]) {
      const called = vi.fn(operation);
      expect(
        await denial(runAuthenticatedStartAdmin(context, request('unit-admin-token'), called), 503),
      ).toMatchObject({ error: 'contract_epoch_fenced', reason: 'unavailable' });
      expect(called).not.toHaveBeenCalled();
    }
    expect(seams.dbImport).not.toHaveBeenCalled();
  });
});
describe('authenticated canonical admin consumers', () => {
  it('returns every rich DTO unchanged, without a JSON roundtrip or null substitution', async () => {
    const fixtures = [
      adminRuns,
      adminDetail,
      adminCost,
      adminFailures,
      adminCoverage,
      adminConjectures,
    ];
    for (const [i, operation] of operations.entries()) {
      expect(
        await runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), operation),
      ).toBe(fixtures[i]);
    }
    expect(adminDetail.ledger[0].cost).toBeNull();
    expect(adminDetail.tool_calls[0].occurred_at).toBe('2026-10-08T02:00:00.500Z');
  });
  it('uses only the injected database and clock and canonical parsers/defaults/caps', async () => {
    const database = db;
    seams.dbImport.mockClear();
    const now = new Date('2026-10-08T02:04:00.123Z');
    const run = <T>(op: (reader: Reader) => Promise<T>) =>
      runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), op, { database, now });
    await run((r) => r.getRuns());
    expect(seams.runs).toHaveBeenLastCalledWith(database, { limit: 50 });
    await run((r) =>
      r.getRuns({ limit: '999', status: 'failure', task_kind: ' original ', cursor: 'opaque' }),
    );
    expect(seams.runs).toHaveBeenLastCalledWith(database, {
      limit: 200,
      status: 'failure',
      taskKind: ' original ',
      cursor: 'opaque',
    });
    await run((r) => r.getCost({ days: '7.9days' }));
    expect(seams.cost).toHaveBeenLastCalledWith(database, { days: 7 }, now);
    await run((r) => r.getCost());
    expect(seams.cost).toHaveBeenLastCalledWith(database, { days: 30 }, now);
    await run((r) => r.getFailures());
    expect(seams.failures).toHaveBeenLastCalledWith(database, { limit: 200 });
    await run((r) => r.getFailures({ limit: 'bad' }));
    expect(seams.failures).toHaveBeenLastCalledWith(database, { limit: 50 });
    await run((r) => r.getCoverage());
    await run((r) => r.getConjectureScores());
    expect(seams.coverage).toHaveBeenLastCalledWith(database, now);
    expect(seams.conjectures).toHaveBeenLastCalledWith(database);
    expect(seams.dbImport).not.toHaveBeenCalled();
  });
  it.each(['bad', '0', '-1', '2.5'])(
    'rejects invalid limit %s after auth, before DB access',
    async (limit) => {
      expect(
        await denial(
          runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), (r) =>
            r.getRuns({ limit }),
          ),
          400,
        ),
      ).toMatchObject({ error: 'validation_error' });
      expect(seams.runs).not.toHaveBeenCalled();
      expect(seams.dbImport).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid status and detail input before DB access', async () => {
    await denial(
      runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), (r) =>
        r.getRuns({ status: 'invalid' }),
      ),
      400,
    );
    await denial(
      runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), (r) =>
        r.getRunDetail({ id: '' }),
      ),
      400,
    );
    expect(seams.runs).not.toHaveBeenCalled();
    expect(seams.detail).not.toHaveBeenCalled();
    expect(seams.dbImport).not.toHaveBeenCalled();
  });
  it('keeps the missing-detail 404 and public cursor validation errors', async () => {
    seams.detail.mockResolvedValueOnce(null);
    expect(
      await denial(
        runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), (r) =>
          r.getRunDetail({ id: 'missing' }),
        ),
        404,
      ),
    ).toEqual({ error: 'not_found', message: 'no run missing' });
    seams.runs.mockRejectedValueOnce(
      new ApiError('invalid_cursor', 'invalid admin run cursor', 400),
    );
    expect(
      await denial(
        runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), (r) =>
          r.getRuns({ cursor: 'bad' }),
        ),
        400,
      ),
    ).toMatchObject({ error: 'invalid_cursor' });
  });
  it.each(operations)(
    'shapes reader exceptions without leaking database/provider detail',
    async (operation) => {
      const secret = new Error('DB password=secret provider-key=secret');
      for (const load of [
        seams.runs,
        seams.detail,
        seams.cost,
        seams.failures,
        seams.coverage,
        seams.conjectures,
      ])
        load.mockRejectedValue(secret);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(
        await denial(
          runAuthenticatedStartAdmin(allowed(), request('unit-admin-token'), operation),
          500,
        ),
      ).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
      log.mockRestore();
    },
  );
});
