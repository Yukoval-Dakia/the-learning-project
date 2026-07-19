// @vitest-environment jsdom
// YUK-713 round-2 (codex P2) — the undo endpoint answers HTTP 200 even when it did NOT
// restore the note (concurrent version drift = status 'skipped:version_conflict'). The
// client must turn that false-success into a rejection so every caller (note reader +
// Today changes strip) sees a failure instead of a 200.

import { ApiError, TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoAiChange } from './notes-api';

function mockFetch(status: string) {
  return vi.fn(async () => Response.json({ status, artifact_id: 'art_1' }));
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
});
afterEach(() => vi.unstubAllGlobals());

describe('undoAiChange status contract (YUK-713)', () => {
  it('rejects with a 409 when the undo skipped on version_conflict (200 that did not restore)', async () => {
    vi.stubGlobal('fetch', mockFetch('skipped:version_conflict'));
    const err = await undoAiChange('art_1', 'ev_1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });

  it('resolves when the undo actually restored the note', async () => {
    vi.stubGlobal('fetch', mockFetch('undone'));
    await expect(undoAiChange('art_1', 'ev_1')).resolves.toMatchObject({ status: 'undone' });
  });

  it('resolves on already_undone — the change is reverted either way (idempotent no-op)', async () => {
    vi.stubGlobal('fetch', mockFetch('skipped:already_undone'));
    await expect(undoAiChange('art_1', 'ev_1')).resolves.toMatchObject({
      status: 'skipped:already_undone',
    });
  });
});
