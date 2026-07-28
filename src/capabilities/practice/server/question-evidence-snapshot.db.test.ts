import { question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadAttemptQuestionSnapshot } from './question-evidence-snapshot';

const NOW = new Date('2026-07-27T00:00:00Z');

describe('attempt question evidence snapshot (YUK-804)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('freezes a part question and its shared parent with independent versions', async () => {
    const db = testDb();
    await db.insert(question).values([
      {
        id: 'q_parent',
        kind: 'short_answer',
        prompt_md: '共享旧题干',
        reference_md: '共享旧参考',
        knowledge_ids: [],
        source: 'manual',
        draft_status: 'active',
        version: 3,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: 'q_part',
        kind: 'question_part',
        prompt_md: '旧子题',
        reference_md: '旧子题答案',
        parent_question_id: 'q_parent',
        knowledge_ids: [],
        source: 'manual',
        draft_status: 'active',
        version: 7,
        created_at: NOW,
        updated_at: NOW,
      },
    ]);

    const snapshot = await loadAttemptQuestionSnapshot(db, 'q_part');
    await db
      .update(question)
      .set({ prompt_md: '编辑后的子题', version: 8, updated_at: new Date(NOW.getTime() + 1_000) })
      .where(eq(question.id, 'q_part'));
    await db
      .update(question)
      .set({
        prompt_md: '编辑后的共享题干',
        version: 4,
        updated_at: new Date(NOW.getTime() + 1_000),
      })
      .where(eq(question.id, 'q_parent'));

    expect(snapshot).toMatchObject({
      schema_version: 1,
      question: {
        question_id: 'q_part',
        question_version: 7,
        parent_question_id: 'q_parent',
        prompt_md: '旧子题',
      },
      parent_question: {
        question_id: 'q_parent',
        question_version: 3,
        prompt_md: '共享旧题干',
      },
    });
  });

  it('fails closed when a part question has no readable shared parent', async () => {
    const db = testDb();
    await db.insert(question).values({
      id: 'q_orphan',
      kind: 'question_part',
      prompt_md: '孤立子题',
      parent_question_id: 'q_missing_parent',
      knowledge_ids: [],
      source: 'manual',
      draft_status: 'active',
      created_at: NOW,
      updated_at: NOW,
    });

    await expect(loadAttemptQuestionSnapshot(db, 'q_orphan')).rejects.toThrow(
      'loadAttemptQuestionSnapshot: parent question q_missing_parent not found',
    );
  });
});
