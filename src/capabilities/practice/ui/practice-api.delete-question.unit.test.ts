// @vitest-environment jsdom

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteQuestion } from './practice-api';

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

describe('deleteQuestion rolling compatibility (YUK-298)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
    });
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses detail parts as a conservative fallback when an older API omits children', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'confirm_required',
            has_associations: false,
            associations: { attempts: 0, mistakes: 0, fsrs_cards: 0, paper_refs: 0 },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await deleteQuestion('parent', { fallbackChildren: 2 });

    expect(result.kind).toBe('confirm_required');
    if (result.kind !== 'confirm_required') throw new Error('expected confirmation gate');
    expect(result.associations.children).toBe(2);
    expect(result.has_associations).toBe(true);
  });

  it('returns zero-count confirmation data when a 409 omits associations entirely', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'confirm_required' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await deleteQuestion('standalone');

    expect(result).toEqual({
      kind: 'confirm_required',
      associations: { attempts: 0, mistakes: 0, fsrs_cards: 0, paper_refs: 0, children: 0 },
      has_associations: false,
    });
  });

  it('preserves a true aggregate flag when a 409 omits association counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'confirm_required', has_associations: true }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await deleteQuestion('legacy-associated');

    expect(result.kind).toBe('confirm_required');
    if (result.kind !== 'confirm_required') throw new Error('expected confirmation gate');
    expect(result.associations).toEqual({
      attempts: 0,
      mistakes: 0,
      fsrs_cards: 0,
      paper_refs: 0,
      children: 0,
    });
    expect(result.has_associations).toBe(true);
  });
});
