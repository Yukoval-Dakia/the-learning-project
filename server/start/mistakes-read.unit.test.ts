import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MistakeListResponse } from '@/capabilities/ingestion/public';
import { ApiError } from '@/kernel/http';
import { buildHonoApp } from '../app';
import { readAuthenticatedStartMistakes } from './mistakes-read';
import { readStartMistakes } from './mistakes-reader';

const imports = vi.hoisted(() => ({ db: vi.fn(), public: vi.fn(), read: vi.fn() }));
vi.mock('@/db/client', () => {
  imports.db();
  return { db: { connection: 'unit-only-no-database' } };
});
vi.mock('@/capabilities/ingestion/public', () => {
  imports.public();
  return { readMistakes: imports.read };
});

const rows: MistakeListResponse['rows'] = [];
const result: MistakeListResponse = {
  rows,
  data: rows,
  next_cursor: 'opaque:equal-time:attempt-b',
  page: { limit: 200, next_cursor: 'opaque:equal-time:attempt-b' },
};
const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/mistakes', {
    headers: token ? { 'x-internal-token': token } : {},
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('live Start mistakes consumer', () => {
  it.each([undefined, '', 'wrong', 'test-token-extra'])(
    'rejects %s before any DB import or reader',
    async (token) => {
      vi.stubEnv('INTERNAL_TOKEN', 'test-token');
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const read = vi.fn(readStartMistakes);
      const denied = await readAuthenticatedStartMistakes(
        { api: buildHonoApp([], { epochGate }), readMistakes: read },
        request(token),
        { limit: '200', subject: 'math' },
      ).catch((error) => error);
      expect(denied).toBeInstanceOf(Response);
      expect(denied.status).toBe(401);
      expect(epochGate).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(imports.db).not.toHaveBeenCalled();
      expect(imports.public).not.toHaveBeenCalled();
    },
  );

  it('preserves epoch fencing before the operation or DB import', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const read = vi.fn(readStartMistakes);
    const api = buildHonoApp([], {
      epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
    });
    const denied = await readAuthenticatedStartMistakes(
      { api, readMistakes: read },
      request('test-token'),
      {},
    ).catch((error) => error);
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({ error: 'contract_epoch_fenced' });
    expect(read).not.toHaveBeenCalled();
    expect(imports.db).not.toHaveBeenCalled();
  });

  it('calls only the public operation with unchanged filters and opaque cursor after auth', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const epochGate = vi.fn(async () => ({ runnable: true }));
    const input = {
      limit: '200',
      subject: ' custom science ',
      since: '2026-10-08T00:00:00Z',
      question_id: 'frozen-group-part',
      cursor: 'opaque:equal-time:attempt-a',
    };
    imports.read.mockResolvedValueOnce(result);
    const value = await readAuthenticatedStartMistakes(
      { api: buildHonoApp([], { epochGate }), readMistakes: readStartMistakes },
      request('test-token'),
      input,
    );
    expect(epochGate).toHaveBeenCalled();
    expect(imports.db.mock.invocationCallOrder[0]).toBeGreaterThan(
      epochGate.mock.invocationCallOrder[0],
    );
    expect(imports.read).toHaveBeenCalledExactlyOnceWith(
      { connection: 'unit-only-no-database' },
      input,
    );
    expect(value).toBe(result);
    expect(value.data).toBe(value.rows);
    expect(value.page.next_cursor).toBe(value.next_cursor);
  });

  it('retains validation errors rather than returning an empty list', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const error = new ApiError('validation_error', 'cursor is invalid', 400);
    imports.read.mockRejectedValueOnce(error);
    const denied = await readAuthenticatedStartMistakes(
      {
        api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }),
        readMistakes: readStartMistakes,
      },
      request('test-token'),
      { cursor: 'invalid' },
    ).catch((error) => error);
    expect(denied).toBeInstanceOf(Response);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({
      error: 'validation_error',
      message: 'cursor is invalid',
    });
  });
});
