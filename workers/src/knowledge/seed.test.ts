import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { seedKnowledge } from './seed';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const existingIds = new Set<string>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/select id from knowledge where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return existingIds.has(id) ? { id } : null;
          }
          return null;
        },
        run: async () => {
          if (/insert into knowledge/i.test(sql)) {
            existingIds.add(binds[0] as string);
          }
          return { success: true };
        },
      };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls, existingIds };
}

describe('seedKnowledge', () => {
  it('inserts 7 wenyan top-level nodes on first run', async () => {
    const { db, calls } = makeMockDb();
    const result = await seedKnowledge(db);
    expect(result.inserted).toBe(7);
    expect(result.skipped).toBe(0);
    const inserts = calls.filter((c) => /insert into knowledge/i.test(c.sql));
    expect(inserts).toHaveLength(7);
    expect(inserts[0].binds[2]).toBe('wenyan');
    expect(inserts[0].binds[3]).toBeNull();
  });

  it('is idempotent — second run inserts 0', async () => {
    const { db } = makeMockDb();
    await seedKnowledge(db);
    const result2 = await seedKnowledge(db);
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(7);
  });

  it('uses stable id derived from slug', async () => {
    const { db, calls } = makeMockDb();
    await seedKnowledge(db);
    const inserts = calls.filter((c) => /insert into knowledge/i.test(c.sql));
    const ids = inserts.map((c) => c.binds[0] as string);
    expect(ids).toContain('seed:wenyan:shici');
    expect(ids).toContain('seed:wenyan:lunshu');
  });
});
