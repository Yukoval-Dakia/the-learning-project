// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_STORAGE_KEY, apiJson } from './api';
import { buildSessionTransitionRequest } from './session-transition';

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, value),
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
  });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'internal-test-token');
});

afterEach(() => vi.unstubAllGlobals());

describe('apiJson keepalive delivery (YUK-211)', () => {
  it('preserves keepalive while apiFetch adds the internal-token header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiJson(
      '/api/review-sessions/review_1',
      buildSessionTransitionRequest('paused', { keepalive: true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('x-internal-token')).toBe('internal-test-token');
  });
});
