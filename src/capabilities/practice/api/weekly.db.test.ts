import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './weekly';

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
});
