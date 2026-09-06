import { beforeEach, describe, expect, it } from 'vitest';
import { artifact, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { isLivePrimaryViewArtifact } from './primary-view-reference';

describe('Copilot primary-view reference ownership', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('accepts only an existing non-archived artifact with a matching product type', async () => {
    const now = new Date('2026-09-06T10:00:00Z');
    await testDb()
      .insert(artifact)
      .values([
        {
          id: 'artifact_live_quiz',
          type: 'tool_quiz',
          title: 'Live quiz',
          intent_source: 'quiz_gen',
          source: 'ai_generated',
          archived_at: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'artifact_archived_note',
          type: 'note_atomic',
          title: 'Archived note',
          intent_source: 'learning_intent',
          source: 'ai_generated',
          archived_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'artifact_unknown_type',
          type: 'future_unknown_type',
          title: 'Unknown type',
          intent_source: 'declared',
          source: 'user',
          archived_at: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    await testDb()
      .insert(question)
      .values([
        {
          id: 'question_live',
          kind: 'short_answer',
          prompt_md: '求函数的定义域。',
          knowledge_ids: ['kc_function'],
          difficulty: 3,
          source: 'ai_generated',
          draft_status: 'draft',
          created_at: now,
          updated_at: now,
        },
        {
          id: 'question_archived',
          kind: 'short_answer',
          prompt_md: '已归档题。',
          knowledge_ids: [],
          difficulty: 2,
          source: 'ai_generated',
          draft_status: 'draft',
          metadata: { archived_at: now.toISOString() },
          created_at: now,
          updated_at: now,
        },
      ]);

    await expect(
      isLivePrimaryViewArtifact(testDb(), { kind: 'quiz', id: 'artifact_live_quiz' }),
    ).resolves.toBe(true);
    await expect(
      isLivePrimaryViewArtifact(testDb(), {
        kind: 'interactive',
        id: 'artifact_live_quiz',
      }),
    ).resolves.toBe(false);
    await expect(
      isLivePrimaryViewArtifact(testDb(), { kind: 'note', id: 'artifact_archived_note' }),
    ).resolves.toBe(false);
    await expect(
      isLivePrimaryViewArtifact(testDb(), { kind: 'note', id: 'artifact_missing' }),
    ).resolves.toBe(false);
    await expect(
      isLivePrimaryViewArtifact(testDb(), {
        kind: 'future_unknown_type',
        id: 'artifact_unknown_type',
      }),
    ).resolves.toBe(false);
    await expect(
      isLivePrimaryViewArtifact(testDb(), { kind: 'question', id: 'question_live' }),
    ).resolves.toBe(true);
    await expect(
      isLivePrimaryViewArtifact(testDb(), { kind: '题目', id: 'question_archived' }),
    ).resolves.toBe(false);
  });
});
