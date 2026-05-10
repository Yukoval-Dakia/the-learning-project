import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { loadTreeSnapshot } from './tree';

function mockDb(rows: Array<Record<string, unknown>>) {
  return {
    prepare: vi.fn(() => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    })),
  } as unknown as D1Database;
}

describe('loadTreeSnapshot', () => {
  it('walks parent chain to fill effective_domain on child rows', async () => {
    const db = mockDb([
      { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null },
      { id: 'k2', name: '之', domain: null, parent_id: 'k1', archived_at: null },
      { id: 'k3', name: '主谓间用法', domain: null, parent_id: 'k2', archived_at: null },
    ]);
    const tree = await loadTreeSnapshot(db);
    expect(tree).toHaveLength(3);
    expect(tree.find((r) => r.id === 'k1')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k2')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k3')?.effective_domain).toBe('wenyan');
  });

  it('caps walk depth at 32 (cycle protection)', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 40; i++) {
      rows.push({
        id: `k${i}`,
        name: `n${i}`,
        domain: i === 0 ? 'wenyan' : null,
        parent_id: i === 0 ? null : `k${i - 1}`,
        archived_at: null,
      });
    }
    const db = mockDb(rows);
    const tree = await loadTreeSnapshot(db);
    expect(tree.find((r) => r.id === 'k0')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k32')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k33')?.effective_domain).toBeNull();
  });
});
