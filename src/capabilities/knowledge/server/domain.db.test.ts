import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  batchResolveEffectiveDomains,
  getEffectiveDomain,
  resolveSubjectKnowledgeIds,
} from './domain';

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

// YUK-716 — batchResolveEffectiveDomains must resolve BYTE-IDENTICALLY to the per-node
// getEffectiveDomain caught-to-null, INCLUDING the 32-hop MAX_DEPTH cap (codex #913 P2): a
// domain-bearing ancestor beyond the cap must NOT leak into the batch (which would shift
// effectiveThetaForKcBatch's θ_global vs the single path's max-depth throw → θ_global=0).
describe('batchResolveEffectiveDomains (YUK-716 — mirrors getEffectiveDomain incl. MAX_DEPTH)', () => {
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

  // Seed a linear chain `<prefix>_0 → <prefix>_1 → … → <prefix>_{length-1}`. The leaf
  // (`_0`) is the start node; only the root (`_{length-1}`) carries `rootDomain`. The
  // domain-bearing root therefore sits at climb-level `length-1` from the start node.
  // Rows are inserted root-first so each node's parent already exists.
  async function seedChain(
    db: ReturnType<typeof testDb>,
    prefix: string,
    length: number,
    rootDomain: string,
  ): Promise<string> {
    const rows = [];
    for (let i = length - 1; i >= 0; i--) {
      const isRoot = i === length - 1;
      rows.push({
        id: `${prefix}_${i}`,
        name: `${prefix}_${i}`,
        domain: isRoot ? rootDomain : null,
        parent_id: isRoot ? null : `${prefix}_${i + 1}`,
        ...base,
      });
    }
    await db.insert(knowledge).values(rows);
    return `${prefix}_0`;
  }

  it('resolves a domain AT the cap (climb-level 31, the 32nd node) identically to getEffectiveDomain', async () => {
    const db = testDb();
    // 32 nodes → domain at climb-level 31 (inspected within the 32-iteration cap).
    const kc = await seedChain(db, 'atcap', 32, 'deep_at_cap');
    const single = await getEffectiveDomain(db, kc);
    const batch = await batchResolveEffectiveDomains(db, [kc]);
    expect(single).toBe('deep_at_cap');
    expect(batch.get(kc)).toBe(single); // byte-identical at the boundary
  });

  it('mirrors the MAX_DEPTH throw: a domain BEYOND 32 hops → null (batch) == throw→null (single)', async () => {
    const db = testDb();
    // 33 nodes → domain at climb-level 32, one past the cap: single throws max-depth.
    const kc = await seedChain(db, 'beyond', 33, 'deep_beyond');
    await expect(getEffectiveDomain(db, kc)).rejects.toThrow(/max depth/i);
    const batch = await batchResolveEffectiveDomains(db, [kc]);
    // getEffectiveDomain throws → callers catch → null domain (θ_global=0). The batch MUST
    // produce the SAME null, NOT the deep ancestor's domain it could reach by ignoring the cap.
    expect(batch.get(kc)).toBeNull();
  });

  it('agrees on not-found / root-null / normal resolution in one batch', async () => {
    const db = testDb();
    await db.insert(knowledge).values([
      { id: 'r', name: 'r', domain: 'yuwen', parent_id: null, ...base },
      { id: 'c', name: 'c', domain: null, parent_id: 'r', ...base },
      { id: 'bad_root', name: 'bad_root', domain: null, parent_id: null, ...base },
    ]);
    const batch = await batchResolveEffectiveDomains(db, ['c', 'r', 'bad_root', 'missing']);
    expect(batch.get('c')).toBe('yuwen'); // normal walk
    expect(batch.get('r')).toBe('yuwen'); // root with domain
    expect(batch.get('bad_root')).toBeNull(); // root null domain → single throws → null
    expect(batch.get('missing')).toBeNull(); // not found → single throws → null
    // Cross-check the single path agrees on each id.
    expect(await getEffectiveDomain(db, 'c')).toBe('yuwen');
    await expect(getEffectiveDomain(db, 'bad_root')).rejects.toThrow(/root.*domain/i);
    await expect(getEffectiveDomain(db, 'missing')).rejects.toThrow(/not found/i);
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

  it('an observed unconfigured domain resolves by exact normalized raw identity', async () => {
    const db = testDb();
    await db.insert(knowledge).values([
      { id: 'english-root', name: 'English', domain: 'YINGYU', parent_id: null, ...base },
      { id: 'english-child', name: 'Grammar', domain: null, parent_id: 'english-root', ...base },
      { id: 'nearby', name: 'Other', domain: 'yingyu-extra', parent_id: null, ...base },
      { id: 'untagged', name: 'None', domain: null, parent_id: null, ...base },
    ]);
    expect(new Set(await resolveSubjectKnowledgeIds(db, ' yingyu '))).toEqual(
      new Set(['english-root', 'english-child']),
    );
  });
});
