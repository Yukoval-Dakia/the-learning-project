// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, TOKEN_STORAGE_KEY, subscribeAuthInvalidation } from '@/ui/lib/api';
import { listStartMistakes } from './mistakes-client';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./mistakes-function', () => ({ getStartMistakes: rpc.call }));

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'fixture-token');
  vi.stubGlobal('fetch', vi.fn());
  rpc.call.mockImplementation(async (options) => {
    const response = await options.fetch('/_serverFn/live-mistakes', {
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

describe('Start mistakes browser transport', () => {
  it('uses the live function with the retained token and page subject/limit', async () => {
    const rows = [
      {
        id: 'frozen-attempt',
        prompt_md: '历史题面\n嵌套条件与长文本'.repeat(25),
        wrong_answer_image_refs: ['page-2', 'page-1'],
        cause: { source: 'user', primary_category: 'misc', user_notes: 'unknown preserved' },
        correction_state: { chain: [{ event_id: 'frozen-attempt', state: 'superseded' }] },
      },
    ];
    const result = {
      rows,
      data: rows,
      page: { limit: 200, next_cursor: 'opaque-next' },
      next_cursor: 'opaque-next',
    };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(result));
    expect(await listStartMistakes({ limit: 200, subject: 'custom-science' })).toEqual(result);
    expect(rpc.call.mock.calls[0][0].data).toEqual({ limit: '200', subject: 'custom-science' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/_serverFn/live-mistakes');
    expect(new Headers(init?.headers).get('x-internal-token')).toBe('fixture-token');
    expect(new Headers(init?.headers).get('x-tsr-serverFn')).toBe('true');
    expect(init?.method).toBe('GET');
  });

  it('makes no request without a token', async () => {
    window.localStorage.clear();
    await expect(listStartMistakes({ limit: 200 })).rejects.toBeInstanceOf(ApiAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the token and re-gates after a server 401', async () => {
    const invalidated = vi.fn();
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    try {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: 'unauthorized' }, { status: 401 }),
      );
      await expect(listStartMistakes({ limit: 200 })).rejects.toBeInstanceOf(ApiAuthError);
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
    const error = await listStartMistakes({ limit: 200 }).catch((error) => error);
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
