import { knowledge, learning_item } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { planTeachingTurn } from './teaching';

describe('planTeachingTurn', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('passes the subject profile resolved from the first knowledge node', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_math',
      name: '一元二次方程',
      domain: 'math',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(learning_item).values({
      id: 'li_math',
      source: 'learning_intent',
      title: '一元二次方程求根',
      content: '能用配方法和公式法求根，并检查答案。',
      knowledge_ids: ['k_math'],
      primary_artifact_id: null,
      parent_learning_item_id: null,
      child_learning_item_ids: [],
      status: 'pending',
      user_pinned: false,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        kind: 'explain',
        text_md: '先看方程结构，再选配方法或公式法。',
        suggested_next: 'continue',
      }),
    }));

    const turn = await planTeachingTurn({
      db,
      sessionId: 's_math',
      learningItemId: 'li_math',
      runTaskFn,
    });

    expect(turn.kind).toBe('explain');
    const ctx = runTaskFn.mock.calls[0]?.[2] as unknown as { subjectProfile?: { id: string } };
    expect(ctx.subjectProfile?.id).toBe('math');
  });
});
