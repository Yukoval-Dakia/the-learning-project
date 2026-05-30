// T-QP (YUK-165) — part-creation owner DB test. Lives in the `db` partition
// (imports @/db + tests/helpers/db). Verifies a part is a `question` row tagged
// kind='question_part', linked to its parent via parent_question_id + part_index,
// with created_by NULL (provenance via metadata).

import { question } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { QUESTION_PART_KIND, createQuestionPart, representMultiPartQuestion } from './parts';

async function seedParent(id: string): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `parent ${id}`,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('createQuestionPart (T-QP owner)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a part as a question row linked to its parent', async () => {
    const db = testDb();
    const parentId = createId();
    await seedParent(parentId);
    const now = new Date();

    const created = await db.transaction((tx) =>
      createQuestionPart(tx, {
        parentQuestionId: parentId,
        partIndex: 0,
        promptMd: 'sub-question (1)',
        referenceMd: 'ref-1',
        knowledgeIds: ['k1'],
        source: 'manual',
        now,
      }),
    );

    const rows = await db.select().from(question).where(eq(question.id, created.questionId));
    expect(rows).toHaveLength(1);
    const part = rows[0];
    expect(part.kind).toBe(QUESTION_PART_KIND);
    expect(part.parent_question_id).toBe(parentId);
    expect(part.part_index).toBe(0);
    expect(part.prompt_md).toBe('sub-question (1)');
    expect(part.reference_md).toBe('ref-1');
    // created_by stays NULL by design (ADR-0006 v2); provenance via metadata.
    expect(part.created_by).toBeNull();
    expect(part.metadata).toMatchObject({ part_of_question_id: parentId, part_index: 0 });
  });

  it('represents a multi-part question as parent + ordered parts', async () => {
    const db = testDb();
    const parentId = createId();
    await seedParent(parentId);
    const now = new Date();

    const created = await db.transaction((tx) =>
      representMultiPartQuestion(tx, {
        parentQuestionId: parentId,
        source: 'manual',
        now,
        parts: [{ promptMd: 'part a' }, { promptMd: 'part b' }, { promptMd: 'part c' }],
      }),
    );

    expect(created.map((c) => c.partIndex)).toEqual([0, 1, 2]);

    const parts = await db.select().from(question).where(eq(question.parent_question_id, parentId));
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.kind === QUESTION_PART_KIND)).toBe(true);
    const byIndex = [...parts].sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
    expect(byIndex.map((p) => p.prompt_md)).toEqual(['part a', 'part b', 'part c']);
  });

  it('a plain (non-part) question keeps parent_question_id / part_index NULL', async () => {
    const db = testDb();
    const plainId = createId();
    await seedParent(plainId); // seedParent inserts a normal question, no part fields
    const rows = await db.select().from(question).where(eq(question.id, plainId));
    expect(rows[0].parent_question_id).toBeNull();
    expect(rows[0].part_index).toBeNull();
    expect(rows[0].kind).toBe('short_answer');
  });
});
