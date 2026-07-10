import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getEffectiveDomain, resolveSubjectKnowledgeIds } from './domain';

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
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    expect(await getEffectiveDomain(db, 'k1')).toBe('yuwen');
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
      { id: 'k_root', name: 'root', domain: 'yuwen', parent_id: null, ...base },
      { id: 'k_mid', name: 'mid', domain: null, parent_id: 'k_root', ...base },
      { id: 'k_leaf', name: 'leaf', domain: null, parent_id: 'k_mid', ...base },
    ]);
    expect(await getEffectiveDomain(db, 'k_leaf')).toBe('yuwen');
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

// YUK-603 (v2 contract §5.4) — "科目的 KC 集" = content child KCs only, never the synthetic
// structural anchor. The seed root's domain = its own subject id, so pre-fix it SELF-MATCHED
// into every subject resolution — the day-one non-empty set that armed the scope-freeze bug.
describe('resolveSubjectKnowledgeIds (synthetic-root exclusion + canonicalization)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const now = new Date();
  const base = {
    merged_from: [] as string[],
    proposed_by_ai: false,
    approval_status: 'approved' as const,
    created_at: now,
    updated_at: now,
    version: 0,
  };

  it('day-one: a seed-root-only tree resolves to [] (root excluded at the source)', async () => {
    const db = testDb();
    await db
      .insert(knowledge)
      .values({ id: 'seed:yuwen:root', name: '语文', domain: 'yuwen', parent_id: null, ...base });
    expect(await resolveSubjectKnowledgeIds(db, 'yuwen')).toEqual([]);
  });

  it('content children resolve; the seed root itself never does', async () => {
    const db = testDb();
    await db.insert(knowledge).values([
      { id: 'seed:yuwen:root', name: '语文', domain: 'yuwen', parent_id: null, ...base },
      { id: 'kc1', name: '虚词', domain: null, parent_id: 'seed:yuwen:root', ...base },
    ]);
    expect(await resolveSubjectKnowledgeIds(db, 'yuwen')).toEqual(['kc1']);
  });

  it('a 3a runtime topic root (newId + parent_id null) is NOT excluded — exclusion is id-pattern, not parent_id IS NULL', async () => {
    const db = testDb();
    await db.insert(knowledge).values([
      { id: 'seed:yuwen:root', name: '语文', domain: 'yuwen', parent_id: null, ...base },
      // learning_intent 3a shape: runtime-minted topic root, own domain, no parent.
      { id: 'k7f3topic', name: '古文观止', domain: 'yuwen', parent_id: null, ...base },
      { id: 'kc1', name: '篇一', domain: null, parent_id: 'k7f3topic', ...base },
    ]);
    const resolved = (await resolveSubjectKnowledgeIds(db, 'yuwen')).sort();
    expect(resolved).toEqual(['k7f3topic', 'kc1']); // topic root stays; only seed:*:root is out
  });

  it('canonicalizes the subject param: an alias ("wenyan") resolves the canonical subject KC set', async () => {
    // Pre-fix, :105 compared the CANONICAL effective domain against the RAW param, so an
    // alias arg missed everything ("wenyan" vs resolved "yuwen"). §5.4 顺带修.
    const db = testDb();
    await db.insert(knowledge).values([
      { id: 'seed:yuwen:root', name: '语文', domain: 'yuwen', parent_id: null, ...base },
      { id: 'kc1', name: '虚词', domain: null, parent_id: 'seed:yuwen:root', ...base },
    ]);
    expect(await resolveSubjectKnowledgeIds(db, 'wenyan')).toEqual(['kc1']);
  });

  it('an unknown subject label resolves to []', async () => {
    const db = testDb();
    await db
      .insert(knowledge)
      .values({ id: 'kc1', name: 'k', domain: 'yuwen', parent_id: null, ...base });
    expect(await resolveSubjectKnowledgeIds(db, 'no_such_subject')).toEqual([]);
  });
});
