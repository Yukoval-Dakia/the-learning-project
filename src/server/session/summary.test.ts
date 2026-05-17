// SessionSummaryTask runner tests.

import { event, learning_session, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { Review } from '@/server/session';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { runSessionSummary } from './summary';

async function seedQuestion(id: string, prompt: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: prompt,
    reference_md: null,
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
}

async function seedReviewEvent(
  sessionId: string,
  questionId: string,
  rating: 'again' | 'hard' | 'good' | 'easy',
  responseMd: string | null = null,
) {
  const db = testDb();
  const now = new Date();
  const outcome = rating === 'again' ? 'failure' : 'success';
  await writeEvent(db, {
    id: createId(),
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: questionId,
    outcome,
    payload: {
      fsrs_rating: rating,
      fsrs_state_after: {
        due: now,
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: now,
      },
      user_response_md: responseMd,
      referenced_knowledge_ids: [],
    },
    created_at: now,
  });
}

describe('runSessionSummary', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:no_session when session does not exist', async () => {
    const result = await runSessionSummary({
      db: testDb(),
      sessionId: 'no_such',
      runTaskFn: vi.fn(),
    });
    expect(result.status).toBe('skipped:no_session');
  });

  it('returns skipped:no_events when session has no chained review events', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    const runTaskFn = vi.fn();
    const result = await runSessionSummary({ db, sessionId, runTaskFn });
    expect(result.status).toBe('skipped:no_events');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:already_summarized when summary_md is already set', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await db
      .update(learning_session)
      .set({ summary_md: '已写过了' })
      .where(eq(learning_session.id, sessionId));

    const runTaskFn = vi.fn();
    const result = await runSessionSummary({ db, sessionId, runTaskFn });
    expect(result.status).toBe('skipped:already_summarized');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('writes summary_md when LLM returns text', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await seedQuestion('q1', '问题 1');
    await seedReviewEvent(sessionId, 'q1', 'again');
    await seedReviewEvent(sessionId, 'q1', 'good');

    const runTaskFn = vi.fn(async () => ({ text: '复习了 2 题，1 对 1 错。下次重点过 q1。' }));
    const result = await runSessionSummary({ db, sessionId, runTaskFn });

    expect(result.status).toBe('written');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('SessionSummaryTask');
    const callArgs = runTaskFn.mock.calls[0][1] as {
      total_reviewed: number;
      ratings: { again: number; good: number };
    };
    expect(callArgs.total_reviewed).toBe(2);
    expect(callArgs.ratings.again).toBe(1);
    expect(callArgs.ratings.good).toBe(1);

    const rows = await db
      .select({ summary_md: learning_session.summary_md })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].summary_md).toBe('复习了 2 题，1 对 1 错。下次重点过 q1。');
  });

  it('clamps summary to 240 chars when LLM goes long', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await seedQuestion('q1', '问题');
    await seedReviewEvent(sessionId, 'q1', 'good');

    const longText = '一二三四五'.repeat(100); // 500 chars
    const runTaskFn = vi.fn(async () => ({ text: longText }));
    const result = await runSessionSummary({ db, sessionId, runTaskFn });
    expect(result.status).toBe('written');
    expect((result.summary_md ?? '').length).toBe(240);
  });

  it('returns skipped:no_events when LLM returns empty text', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await seedQuestion('q1', '问题');
    await seedReviewEvent(sessionId, 'q1', 'good');

    const runTaskFn = vi.fn(async () => ({ text: '   ' }));
    const result = await runSessionSummary({ db, sessionId, runTaskFn });
    expect(result.status).toBe('skipped:no_events');
    const rows = await db
      .select({ summary_md: learning_session.summary_md })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].summary_md).toBeNull();
  });

  it('includes notable again/hard attempts in the prompt input', async () => {
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db);
    await seedQuestion('q1', '题一');
    await seedQuestion('q2', '题二');
    await seedQuestion('q3', '题三');
    await seedReviewEvent(sessionId, 'q1', 'again', '错了');
    await seedReviewEvent(sessionId, 'q2', 'hard', '勉强');
    await seedReviewEvent(sessionId, 'q3', 'good', '对了');

    const runTaskFn = vi.fn(async () => ({ text: 'summary' }));
    await runSessionSummary({ db, sessionId, runTaskFn });

    const input = runTaskFn.mock.calls[0][1] as {
      notable_attempts: Array<{ prompt_md: string; fsrs_rating: string }>;
    };
    // Both again + hard surface; good doesn't.
    expect(input.notable_attempts).toHaveLength(2);
    const ratings = input.notable_attempts.map((a) => a.fsrs_rating).sort();
    expect(ratings).toEqual(['again', 'hard']);
    // suppress unused-import
    void event;
  });
});
