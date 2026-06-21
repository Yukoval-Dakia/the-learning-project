import { knowledge } from '@/db/schema';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { KNOWN_SUBJECT_IDS } from '@/subjects/profile-schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedKnowledge } from './seed';

const SUBJECT_COUNT = KNOWN_SUBJECT_IDS.length;

describe('seedKnowledge (薄 seed — 仅科目 domain-root 节点, YUK-477)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts exactly one domain-root node per known subject on first run', async () => {
    const db = testDb();
    const result = await seedKnowledge(db);
    expect(result.inserted).toBe(SUBJECT_COUNT);
    expect(result.skipped).toBe(0);

    const rows = await db.select().from(knowledge);
    expect(rows).toHaveLength(SUBJECT_COUNT);
    // every node is a root (parent_id null) and its domain is a known subject id.
    for (const row of rows) {
      expect(row.parent_id).toBeNull();
      expect(row.approval_status).toBe('approved');
      expect(KNOWN_SUBJECT_IDS).toContain(row.domain as (typeof KNOWN_SUBJECT_IDS)[number]);
    }
    // one node per subject, no duplicates.
    const domains = rows.map((r) => r.domain).sort();
    expect(domains).toEqual([...KNOWN_SUBJECT_IDS].sort());
  });

  it('is idempotent — second run inserts 0, skips all', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const result2 = await seedKnowledge(db);
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(SUBJECT_COUNT);
    expect(await db.select().from(knowledge)).toHaveLength(SUBJECT_COUNT);
  });

  it('uses stable id seed:<subjectId>:root', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const ids = (await db.select({ id: knowledge.id }).from(knowledge)).map((r) => r.id);
    for (const subjectId of KNOWN_SUBJECT_IDS) {
      expect(ids).toContain(`seed:${subjectId}:root`);
    }
  });

  it("a seeded node's domain resolves to its own subject id (self-alias)", async () => {
    const db = testDb();
    await seedKnowledge(db);
    const rows = await db.select({ domain: knowledge.domain }).from(knowledge);
    for (const row of rows) {
      // domain=subjectId → resolveKnownSubjectId(domain) === subjectId, so the
      // derived effective-domain axis picks the node up under its own subject.
      expect(resolveKnownSubjectId(row.domain)).toBe(row.domain);
    }
  });
});
