import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadTreeSnapshot } from './tree';

describe('loadTreeSnapshot', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('walks parent chain to fill effective_domain on child rows', async () => {
    const db = testDb();
    const now = new Date();
    const base = {
      merged_from: [] as string[],
      proposed_by_ai: false,
      approval_status: 'approved' as const,
      created_at: now,
      updated_at: now,
      version: 0,
    };
    await db.insert(knowledge).values([
      { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null, ...base },
      { id: 'k2', name: '之', domain: null, parent_id: 'k1', archived_at: null, ...base },
      {
        id: 'k3',
        name: '主谓间用法',
        domain: null,
        parent_id: 'k2',
        archived_at: null,
        ...base,
      },
    ]);
    const tree = await loadTreeSnapshot(db);
    expect(tree).toHaveLength(3);
    expect(tree.find((r) => r.id === 'k1')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k2')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k3')?.effective_domain).toBe('wenyan');
    // A5 S1 (YUK-354) — never-attempted nodes expose the BandChip read shape with
    // cold-start defaults (null/null/false) so the client renders the unknown band.
    const k1 = tree.find((r) => r.id === 'k1');
    expect(k1?.mastery).toBeNull();
    expect(k1?.mastery_lo).toBeNull();
    expect(k1?.mastery_hi).toBeNull();
    expect(k1?.low_confidence).toBe(false);
  });

  it('caps walk depth at 32 (cycle protection)', async () => {
    const db = testDb();
    const now = new Date();
    // Build 40 nodes in a chain; node 0 is root with domain, rest inherit
    const insertValues = Array.from({ length: 40 }, (_, i) => ({
      id: `k${i}`,
      name: `n${i}`,
      domain: i === 0 ? 'wenyan' : null,
      parent_id: i === 0 ? null : `k${i - 1}`,
      archived_at: null,
      merged_from: [] as string[],
      proposed_by_ai: false,
      approval_status: 'approved' as const,
      created_at: now,
      updated_at: now,
      version: 0,
    }));
    // Insert root first, then children in order
    await db.insert(knowledge).values(insertValues);
    const tree = await loadTreeSnapshot(db);
    expect(tree.find((r) => r.id === 'k0')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k32')?.effective_domain).toBe('wenyan');
    expect(tree.find((r) => r.id === 'k33')?.effective_domain).toBeNull();
  });
});
