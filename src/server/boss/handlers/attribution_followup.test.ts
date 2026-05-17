// Task #16 — attribution_followup handler tests.

import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runAttributionFollowup } from './attribution_followup';

async function seedQuestion(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '「之」在「古之学者必有师」中的用法',
    reference_md: '助词，相当于"的"',
    source: 'manual',
    knowledge_ids: ['k_xuci'],
    created_at: now,
    updated_at: now,
  });
}

async function seedFailureAttempt(attemptId: string, qid: string) {
  await writeEvent(testDb(), {
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: qid,
    outcome: 'failure',
    payload: {
      answer_md: '助词，主谓间',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: new Date(),
  });
}

const VALID_ATTRIBUTION_OUTPUT = JSON.stringify({
  primary_category: 'concept',
  secondary_categories: [],
  analysis_md: '用户混淆了「之」的主谓间用法与结构助词用法。',
  confidence: 0.85,
});

describe('runAttributionFollowup', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:attempt_not_found when attempt event does not exist', async () => {
    const runTaskFn = vi.fn();
    const result = await runAttributionFollowup({
      db: testDb(),
      attemptEventId: 'no_such_event',
      runTaskFn,
    });
    expect(result.status).toBe('skipped:attempt_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:not_a_failure_attempt for non-failure events', async () => {
    const db = testDb();
    await seedQuestion('q1');
    const reviewId = createId();
    await writeEvent(db, {
      id: reviewId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: {
          due: new Date(),
          stability: 1,
          difficulty: 5,
          scheduled_days: 1,
          learning_steps: 0,
          reps: 1,
          lapses: 0,
          state: 'review',
          last_review: new Date(),
        },
        user_response_md: 'ok',
        referenced_knowledge_ids: [],
      },
      created_at: new Date(),
    });

    const runTaskFn = vi.fn();
    const result = await runAttributionFollowup({
      db,
      attemptEventId: reviewId,
      runTaskFn,
    });
    expect(result.status).toBe('skipped:not_a_failure_attempt');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:question_not_found when attempt references missing question', async () => {
    const db = testDb();
    const attemptId = createId();
    await writeEvent(db, {
      id: attemptId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_missing',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      created_at: new Date(),
    });

    const runTaskFn = vi.fn();
    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
    });
    expect(result.status).toBe('skipped:question_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('runs AttributionTask + writes chained judge event on happy path', async () => {
    const db = testDb();
    // Seed referenced knowledge node so loadTreeSnapshot returns it
    await db.insert(knowledge).values({
      id: 'k_xuci',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    await seedQuestion('q1');
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_ATTRIBUTION_OUTPUT,
    }));

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
    });
    expect(result.status).toBe('attempted');
    expect(runTaskFn).toHaveBeenCalledTimes(1);

    // Verify chained judge event written
    const judges = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'judge'),
          eq(event.subject_kind, 'event'),
          eq(event.caused_by_event_id, attemptId),
        ),
      );
    expect(judges).toHaveLength(1);
    const p = judges[0].payload as { cause: { primary_category: string } };
    expect(p.cause.primary_category).toBe('concept');
  });

  it('is idempotent — re-running after a judge already exists is a no-op', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'k_xuci',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    await seedQuestion('q1');
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => ({ text: VALID_ATTRIBUTION_OUTPUT }));

    await runAttributionFollowup({ db, attemptEventId: attemptId, runTaskFn });
    await runAttributionFollowup({ db, attemptEventId: attemptId, runTaskFn });

    // Inner runAttributionAndWriteJudgeEvent dedups via getJudgeForAttempt;
    // second call should not write a second judge event.
    const judges = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'judge'),
          eq(event.subject_kind, 'event'),
          eq(event.caused_by_event_id, attemptId),
        ),
      );
    expect(judges).toHaveLength(1);
  });
});
