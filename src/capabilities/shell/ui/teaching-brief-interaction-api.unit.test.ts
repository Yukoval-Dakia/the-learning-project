// @vitest-environment jsdom
//
// YUK-710 (P0F/6) — the interaction telemetry client is a BARE fetch: it must attach the internal
// token + keepalive, but must NOT invalidate the token on a 401 (that would kick the learner back
// to the token gate from a background ledger write). These tests pin exactly that.

import { TOKEN_STORAGE_KEY, subscribeAuthInvalidation } from '@/ui/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportBriefInteraction } from './teaching-brief-interaction-api';

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'internal-test-token');
});

afterEach(() => vi.unstubAllGlobals());

describe('reportBriefInteraction (YUK-710)', () => {
  it('POSTs with the internal token + keepalive, and sends scoped_practice result_event_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ interaction_event_id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    reportBriefInteraction({
      type: 'primary_action_started',
      brief_id: 'b1',
      action_kind: 'scoped_practice',
      result_event_id: 'evt_result',
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/prep-desk/brief/interaction');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get('x-internal-token')).toBe('internal-test-token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: 'primary_action_started',
      action_kind: 'scoped_practice',
      result_event_id: 'evt_result',
    });
  });

  it('does NOT invalidate the token on a 401 (no auth-invalidation listener fires; token kept)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const listener = vi.fn();
    const unsubscribe = subscribeAuthInvalidation(listener);

    reportBriefInteraction({ type: 'brief_seen', brief_id: 'b1', brief_state: 'finding' });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The whole point: a background 401 must NOT clear the token or notify the auth gate.
    expect(listener).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('internal-test-token');
    unsubscribe();
  });

  it('swallows a network rejection without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    // Fire-and-forget: returns void and must never throw synchronously or reject unhandled.
    expect(() =>
      reportBriefInteraction({ type: 'brief_seen', brief_id: 'b1', brief_state: 'finding' }),
    ).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when there is no internal token (never triggers the auth flow)', async () => {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    reportBriefInteraction({ type: 'brief_seen', brief_id: 'b1', brief_state: 'finding' });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
