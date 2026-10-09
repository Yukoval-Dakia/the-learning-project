// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, TOKEN_STORAGE_KEY, subscribeAuthInvalidation } from '@/ui/lib/api';
import { startNoteListClient } from './notes-list-client';
import { noteList } from './notes-list-test-fixtures';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./notes-list-function', () => ({ getStartNoteList: rpc.call }));

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'fixture-token');
  vi.stubGlobal('fetch', vi.fn());
  rpc.call.mockImplementation(async (options) => {
    const response = await options.fetch('/_serverFn/live-notes', {
      method: 'GET',
      signal: undefined,
      headers: { 'x-tsr-serverFn': 'true' },
    });
    return response.json();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('Start notes-list browser transport', () => {
  it.each([
    [undefined, undefined, { subject: undefined, query: undefined }],
    ['custom-science', '  %_\\ α🙂  ', { subject: 'custom-science', query: '%_\\ α🙂' }],
    ['', ' \n ', { subject: undefined, query: undefined }],
  ])(
    'uses native RPC with token and canonical send behavior for %j/%j',
    async (subject, query, data) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(noteList));
      expect(await startNoteListClient(subject, query)).toEqual(noteList);
      expect(rpc.call.mock.calls[0][0].data).toEqual(data);
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe('/_serverFn/live-notes');
      expect(new Headers(init?.headers).get('x-internal-token')).toBe('fixture-token');
      expect(new Headers(init?.headers).get('x-tsr-serverFn')).toBe('true');
      expect(init?.method).toBe('GET');
    },
  );

  it('makes no request without a token', async () => {
    window.localStorage.clear();
    await expect(startNoteListClient()).rejects.toBeInstanceOf(ApiAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the token and re-gates after a server 401', async () => {
    const invalidated = vi.fn();
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    try {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: 'unauthorized' }, { status: 401 }),
      );
      await expect(startNoteListClient()).rejects.toBeInstanceOf(ApiAuthError);
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
      expect(invalidated).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    [400, 'validation_error'],
    [503, 'contract_epoch_fenced'],
  ])('preserves status %s and code %s without clearing authority', async (status, code) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { error: code, message: 'retry must remain visible', reason: 'unavailable' },
        { status },
      ),
    );
    const error = await startNoteListClient().catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status,
      code,
      message: 'retry must remain visible',
      details: { reason: 'unavailable' },
    });
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('fixture-token');
  });
});
