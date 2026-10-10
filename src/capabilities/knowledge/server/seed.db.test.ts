import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, materialized_id_index } from '@/db/schema';
import { gatherAndFoldKnowledgeNode } from '@/server/projections/gather';
import { knowledgeRowToSnapshot } from '@/server/projections/snapshot-mappers';
import { ensureSubjectRoot } from '@/server/subjects/ensure-subject-root';
import { KNOWN_SUBJECT_IDS } from '@/subjects/profile-schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedKnowledge } from './seed';

const SUBJECT_COUNT = KNOWN_SUBJECT_IDS.length;

describe('seedKnowledge (薄 seed — 仅科目 domain-root 节点, YUK-477)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('concurrent bootstrap and subject-root creation share one birth and never overwrite', async () => {
    const db = testDb();
    const subjectId = KNOWN_SUBJECT_IDS[0];
    const [seed, ensured] = await Promise.all([
      seedKnowledge(db),
      db.transaction((tx) => ensureSubjectRoot(tx, subjectId, 'concurrent root name')),
    ]);
    expect(seed.inserted + Number(ensured.created)).toBe(SUBJECT_COUNT);
    expect(await db.select().from(knowledge)).toHaveLength(SUBJECT_COUNT);
    expect(await db.select().from(event)).toHaveLength(SUBJECT_COUNT);
    expect(await db.select().from(materialized_id_index)).toHaveLength(SUBJECT_COUNT);
    for (const row of await db.select().from(knowledge)) {
      expect(await gatherAndFoldKnowledgeNode(db, row.id)).toEqual(knowledgeRowToSnapshot(row));
    }
  });

  it('is idempotent — second run inserts 0, skips all', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const result2 = await seedKnowledge(db);
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(SUBJECT_COUNT);
    expect(await db.select().from(knowledge)).toHaveLength(SUBJECT_COUNT);
    expect(await db.select().from(event)).toHaveLength(SUBJECT_COUNT);
    expect(await db.select().from(materialized_id_index)).toHaveLength(SUBJECT_COUNT);
  });
});
