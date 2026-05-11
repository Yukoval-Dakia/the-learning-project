import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { assertKnowledgeIdsExist } from './validate';

const BASE_KNOWLEDGE = {
  name: 'test node',
  domain: null,
  parent_id: null,
  base_mastery: 0 as const,
  ai_delta_mastery: 0 as const,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

describe('assertKnowledgeIdsExist', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty ids array returns ok:true without querying', async () => {
    const db = testDb();
    const result = await assertKnowledgeIdsExist(db, []);
    expect(result).toEqual({ ok: true });
  });

  it('all ids exist and are not archived — returns ok:true', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      { id: 'k1', ...BASE_KNOWLEDGE, archived_at: null, created_at: now, updated_at: now },
      { id: 'k2', ...BASE_KNOWLEDGE, archived_at: null, created_at: now, updated_at: now },
    ]);
    const result = await assertKnowledgeIdsExist(db, ['k1', 'k2']);
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with missing ids when none exist', async () => {
    const db = testDb();
    const result = await assertKnowledgeIdsExist(db, ['k_missing_1', 'k_missing_2']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('k_missing_1');
      expect(result.missing).toContain('k_missing_2');
    }
  });

  it('archived knowledge node is treated as missing', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k_archived',
        ...BASE_KNOWLEDGE,
        archived_at: now,
        created_at: now,
        updated_at: now,
      },
    ]);
    const result = await assertKnowledgeIdsExist(db, ['k_archived']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('k_archived');
    }
  });

  it('partial match — returns only the missing ids', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(knowledge)
      .values([
        { id: 'k_exists', ...BASE_KNOWLEDGE, archived_at: null, created_at: now, updated_at: now },
      ]);
    const result = await assertKnowledgeIdsExist(db, ['k_exists', 'k_missing']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['k_missing']);
      expect(result.missing).not.toContain('k_exists');
    }
  });
});
