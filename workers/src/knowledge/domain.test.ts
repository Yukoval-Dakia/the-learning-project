import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { getEffectiveDomain } from './domain';

function makeMockDbWithRows(
  rows: Record<string, { domain: string | null; parent_id: string | null }>,
) {
  const prepare = vi.fn((sql: string) => ({
    bind: (id: string) => ({
      first: async () => rows[id] ?? null,
    }),
  }));
  return { prepare } as unknown as D1Database;
}

describe('getEffectiveDomain', () => {
  it('returns own domain if root (parent_id is null)', async () => {
    const db = makeMockDbWithRows({
      k1: { domain: 'wenyan', parent_id: null },
    });
    expect(await getEffectiveDomain(db, 'k1')).toBe('wenyan');
  });

  it('walks up parent chain to find first non-null domain', async () => {
    const db = makeMockDbWithRows({
      k_leaf: { domain: null, parent_id: 'k_mid' },
      k_mid: { domain: null, parent_id: 'k_root' },
      k_root: { domain: 'wenyan', parent_id: null },
    });
    expect(await getEffectiveDomain(db, 'k_leaf')).toBe('wenyan');
  });

  it('throws if node not found', async () => {
    const db = makeMockDbWithRows({});
    await expect(getEffectiveDomain(db, 'k_missing')).rejects.toThrow(/not found/i);
  });

  it('throws if walks to root with null domain (invariant violation)', async () => {
    const db = makeMockDbWithRows({
      k1: { domain: null, parent_id: null },
    });
    await expect(getEffectiveDomain(db, 'k1')).rejects.toThrow(/root.*domain/i);
  });
});
