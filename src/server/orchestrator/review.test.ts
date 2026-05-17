// Phase 2A — Review Orchestrator unit tests.

import { event, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { planReviewSession } from './review';

async function seedQuestion(id: string, prompt = `q ${id}`) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: prompt,
    reference_md: 'ref',
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
}

async function seedFsrsState(questionId: string, dueAt: Date, opts: { lapses?: number } = {}) {
  const db = testDb();
  const state = {
    due: dueAt,
    stability: 1,
    difficulty: 5,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: opts.lapses ?? 0,
    state: 'review' as const,
    last_review: new Date(),
  };
  await db.insert(material_fsrs_state).values({
    id: `f_${questionId}`,
    subject_kind: 'question',
    subject_id: questionId,
    state: state as never,
    due_at: dueAt,
    last_review_event_id: null,
    updated_at: new Date(),
  });
}

async function seedFailureAttempt(
  attemptId: string,
  questionId: string,
  causeCategory: string | null = null,
  daysAgo = 1,
) {
  const db = testDb();
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000);
  await writeEvent(db, {
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: createdAt,
  });

  if (causeCategory) {
    await writeEvent(db, {
      id: `judge_${attemptId}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'AttributionTask',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: causeCategory,
          secondary_categories: [],
          analysis_md: 'test',
          confidence: 0.9,
        },
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: attemptId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(createdAt.getTime() + 60_000),
    });
  }
}

describe('planReviewSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty plan when no due cards + no failure attempts', async () => {
    const plan = await planReviewSession({ db: testDb() });
    expect(plan.queue).toEqual([]);
    expect(plan.session_intent).toBeNull();
  });

  it('surfaces never-reviewed question with priority + rationale', async () => {
    await seedQuestion('q1', '虚词 之');
    await seedFailureAttempt('a1', 'q1', null);

    const plan = await planReviewSession({ db: testDb() });
    expect(plan.queue).toHaveLength(1);
    const item = plan.queue[0];
    expect(item.question_id).toBe('q1');
    expect(item.fsrs_state).toBeNull();
    expect(item.cause).toBeNull();
    expect(item.priority).toBe(3); // null cause = base 3, no overdue/lapse bonus
    expect(item.rationale).toContain('首次复习');
  });

  it('boosts priority for concept-type cause', async () => {
    await seedQuestion('q1');
    await seedFailureAttempt('a1', 'q1', 'concept');

    const plan = await planReviewSession({ db: testDb() });
    expect(plan.queue[0].cause).toBe('concept');
    expect(plan.queue[0].priority).toBe(5); // concept base = 5
    expect(plan.queue[0].rationale).toContain('概念 错因');
  });

  it('uses user_cause over judge when both present', async () => {
    const db = testDb();
    await seedQuestion('q1');
    await seedFailureAttempt('a1', 'q1', 'carelessness'); // judge says carelessness
    // user override: knowledge_gap
    await writeEvent(db, {
      id: 'uc1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'a1',
      outcome: 'success',
      payload: { primary_category: 'knowledge_gap', user_notes: null },
      caused_by_event_id: 'a1',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    const plan = await planReviewSession({ db });
    expect(plan.queue[0].cause).toBe('knowledge_gap');
    expect(plan.queue[0].priority).toBe(4); // knowledge_gap base = 4
  });

  it('adds overdue bonus when ≥7 days past due', async () => {
    await seedQuestion('q1');
    await seedFsrsState('q1', new Date(Date.now() - 10 * 86_400_000), { lapses: 0 });
    await seedFailureAttempt('a1', 'q1', 'calculation'); // base = 3

    const plan = await planReviewSession({ db: testDb() });
    expect(plan.queue[0].priority).toBe(4); // 3 + 1 overdue bonus
    expect(plan.queue[0].rationale).toContain('逾期 10d');
  });

  it('caps priority at 5 even with all bonuses', async () => {
    await seedQuestion('q1');
    await seedFsrsState('q1', new Date(Date.now() - 30 * 86_400_000), { lapses: 5 });
    await seedFailureAttempt('a1', 'q1', 'concept'); // base 5 + 1 + 1 = 7

    const plan = await planReviewSession({ db: testDb() });
    expect(plan.queue[0].priority).toBe(5);
  });

  it('orders never-reviewed first, then by due_at', async () => {
    await seedQuestion('q_overdue');
    await seedFsrsState('q_overdue', new Date(Date.now() - 5 * 86_400_000));
    await seedQuestion('q_new');
    await seedFailureAttempt('a1', 'q_new', null);

    const plan = await planReviewSession({ db: testDb() });
    expect(plan.queue.map((q) => q.question_id)).toEqual(['q_new', 'q_overdue']);
  });

  it('does not call runTaskFn when queue is empty', async () => {
    const runTaskFn = vi.fn(async () => ({ text: 'should not run' }));
    const plan = await planReviewSession({ db: testDb(), runTaskFn });
    expect(plan.queue).toEqual([]);
    expect(plan.session_intent).toBeNull();
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('writes session_intent when runTaskFn succeeds', async () => {
    await seedQuestion('q1');
    await seedFailureAttempt('a1', 'q1', 'concept');

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: '今天有 1 题概念错因，重点复习。',
    }));
    const plan = await planReviewSession({ db: testDb(), runTaskFn });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('ReviewIntentTask');
    expect(plan.session_intent).toBe('今天有 1 题概念错因，重点复习。');
  });

  it('keeps queue intact and returns null intent when runTaskFn throws', async () => {
    await seedQuestion('q1');
    await seedFailureAttempt('a1', 'q1', 'concept');

    const runTaskFn = vi.fn(async () => {
      throw new Error('mimo down');
    });
    const plan = await planReviewSession({ db: testDb(), runTaskFn });
    expect(plan.queue).toHaveLength(1);
    expect(plan.session_intent).toBeNull();
  });

  it('clamps output to limit', async () => {
    for (let i = 0; i < 5; i++) {
      await seedQuestion(`q${i}`);
      await seedFailureAttempt(`a${i}`, `q${i}`, null);
    }
    const plan = await planReviewSession({ db: testDb(), limit: 3 });
    expect(plan.queue).toHaveLength(3);
    expect(plan.window.limit).toBe(3);
    // suppress unused-import lint
    void event;
  });
});
