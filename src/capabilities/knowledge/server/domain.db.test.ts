import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getEffectiveDomain } from './domain';

describe('getEffectiveDomain', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns own domain if root (parent_id is null)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    expect(await getEffectiveDomain(db, 'k1')).toBe('wenyan');
  });

  it('walks up parent chain to find first non-null domain', async () => {
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
      { id: 'k_root', name: 'root', domain: 'wenyan', parent_id: null, ...base },
      { id: 'k_mid', name: 'mid', domain: null, parent_id: 'k_root', ...base },
      { id: 'k_leaf', name: 'leaf', domain: null, parent_id: 'k_mid', ...base },
    ]);
    expect(await getEffectiveDomain(db, 'k_leaf')).toBe('wenyan');
  });

  it('throws if node not found', async () => {
    const db = testDb();
    await expect(getEffectiveDomain(db, 'k_missing')).rejects.toThrow(/not found/i);
  });

  it('throws if walks to root with null domain (invariant violation)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      name: 'bad',
      domain: null,
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(getEffectiveDomain(db, 'k1')).rejects.toThrow(/root.*domain/i);
  });
});
