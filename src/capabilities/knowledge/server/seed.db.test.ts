import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedKnowledge } from './seed';

describe('seedKnowledge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts 7 wenyan top-level nodes on first run', async () => {
    const db = testDb();
    const result = await seedKnowledge(db);
    expect(result.inserted).toBe(7);
    expect(result.skipped).toBe(0);
    const rows = await db.select().from(knowledge);
    expect(rows).toHaveLength(7);
    expect(rows[0].domain).toBe('wenyan');
    expect(rows[0].parent_id).toBeNull();
  });

  it('is idempotent — second run inserts 0', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const result2 = await seedKnowledge(db);
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(7);
  });

  it('uses stable id derived from slug', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const rows = await db.select({ id: knowledge.id }).from(knowledge);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('seed:wenyan:shici');
    expect(ids).toContain('seed:wenyan:lunshu');
  });
});
