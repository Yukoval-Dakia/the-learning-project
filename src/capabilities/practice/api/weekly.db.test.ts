import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './weekly';
import { localDateKey } from './weekly-window';

async function seedReview(id: string, createdAt: Date) {
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: `question_${id}`,
      outcome: 'success',
      payload: { fsrs_rating: 'good' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: createdAt,
    });
}

async function seedFailureWithCauses(opts: {
  attemptId: string;
  questionId: string;
  judgeCategory: string;
  userCategory?: string;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(event).values({
    id: opts.attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
  await db.insert(event).values({
    id: `${opts.attemptId}_judge`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: opts.judgeCategory,
        secondary_categories: [],
        analysis_md: 'agent analysis',
        confidence: 0.8,
      },
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: opts.attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
  if (opts.userCategory) {
    await db.insert(event).values({
      id: `${opts.attemptId}_user_cause`,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: opts.attemptId,
      outcome: null,
      payload: {
        primary_category: opts.userCategory,
        user_notes: 'manual correction',
      },
      caused_by_event_id: opts.attemptId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
  }
}

describe('GET /api/review/weekly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('aggregates top causes through the effective user-first cause policy', async () => {
    await seedFailureWithCauses({
      attemptId: 'attempt_weekly',
      questionId: 'q1',
      judgeCategory: 'concept',
      userCategory: 'memory',
    });

    const res = await GET(new Request('http://localhost/api/review/weekly'));
    const body = (await res.json()) as { top_causes: Array<{ category: string; count: number }> };

    expect(body.top_causes).toEqual([{ category: 'memory', count: 1 }]);
  });

  it('includes the learner current local date and reports the applied time zone', async () => {
    const eventAt = new Date(Date.now() - 1000);
    await seedReview('review_current_local_day', eventAt);

    const res = await GET(
      new Request('http://localhost/api/review/weekly?days=7&timezone=Asia%2FShanghai'),
    );
    const body = (await res.json()) as {
      window: { days: number; time_zone: string };
      daily: Array<{ date: string; count: number; correct: number }>;
    };

    expect(res.status).toBe(200);
    expect(body.window).toMatchObject({ days: 7, time_zone: 'Asia/Shanghai' });
    expect(body.daily).toHaveLength(7);
    expect(body.daily.at(-1)).toEqual({
      date: localDateKey(eventAt, 'Asia/Shanghai'),
      count: 1,
      correct: 1,
    });
  });

  it('rejects an invalid time zone before querying report data', async () => {
    const res = await GET(
      new Request('http://localhost/api/review/weekly?timezone=Mars%2FOlympus'),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_timezone' });
  });
});
