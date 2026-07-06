// Task #16 — attribution_followup handler tests.

import { event, knowledge, question } from '@/db/schema';
import { cost_ledger } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type AttributionFollowupJobData,
  buildAttributionFollowupHandler,
  runAttributionFollowup,
} from './attribution_followup';

async function seedXuciKnowledge() {
  await testDb().insert(knowledge).values({
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
}

async function seedQuestion(id: string, knowledgeIds = ['k_xuci']) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '「之」在「古之学者必有师」中的用法',
    reference_md: '助词，相当于"的"',
    source: 'manual',
    knowledge_ids: knowledgeIds,
    created_at: now,
    updated_at: now,
  });
}

async function seedFailureAttempt(attemptId: string, qid: string, knowledgeIds = ['k_xuci']) {
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
      referenced_knowledge_ids: knowledgeIds,
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

  it('passes the first referenced knowledge subject profile to AttributionTask', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'k_math',
      name: '函数',
      domain: 'math',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    await seedQuestion('q_math', ['k_math']);
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q_math', ['k_math']);

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_ATTRIBUTION_OUTPUT,
    }));

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
    });

    expect(result.status).toBe('attempted');
    expect(runTaskFn.mock.calls[0]?.[2]).toMatchObject({
      subjectProfile: { id: 'math' },
    });
  });

  it('writes a math-specific unit_error judge event from AttributionTask output', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'k_math',
      name: '单位换算',
      domain: 'math',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    await seedQuestion('q_math', ['k_math']);
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q_math', ['k_math']);

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        primary_category: 'unit_error',
        secondary_categories: ['calculation'],
        analysis_md: '用户把厘米和米混用，最终答案量纲不一致。',
        confidence: 0.9,
      }),
    }));

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
    });

    expect(result.status).toBe('attempted');
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
    const payload = judges[0].payload as {
      cause: { primary_category: string; secondary_categories: string[] };
    };
    expect(payload.cause.primary_category).toBe('unit_error');
    expect(payload.cause.secondary_categories).toEqual(['calculation']);
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

  // ── YUK-379 (B1): retryable rethrow + permanent continue ──────────────────

  it('YUK-379: retryable attribution (runTaskFn throws) rethrows and does NOT enqueue variant_gen', async () => {
    const db = testDb();
    await seedXuciKnowledge();
    await seedQuestion('q1');
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM down');
    });
    const enqueueVariantGen = vi.fn(async () => {});

    // The pure runner rethrows the classified-retryable error BEFORE the
    // variant_gen fan-out — so pg-boss retries and no empty variant_gen spins.
    await expect(
      runAttributionFollowup({ db, attemptEventId: attemptId, runTaskFn, enqueueVariantGen }),
    ).rejects.toThrow('LLM down');
    expect(enqueueVariantGen).not.toHaveBeenCalled();

    const judges = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(judges).toHaveLength(0);
    // OCR #6: the retryable path now writes a best-effort failed_retryable ledger
    // row (for the non-rethrowing copilot caller); on this pg-boss path it is
    // redundant with pg-boss + llm_dlq but harmless. The rethrow contract above
    // is unchanged.
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe('failed_retryable');
  });

  it('YUK-379: handler rethrows on retryable so pg-boss retries', async () => {
    const db = testDb();
    await seedXuciKnowledge();
    await seedQuestion('q1');
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM down');
    });
    const handler = buildAttributionFollowupHandler(db, {
      runTaskFn,
      enqueueVariantGen: vi.fn(async () => {}),
    });
    const jobs = [
      { id: 'job1', data: { attempt_event_id: attemptId } },
    ] as Job<AttributionFollowupJobData>[];
    await expect(handler(jobs)).rejects.toThrow('LLM down');
  });

  it('YUK-379: permanent parse failure returns attempted (no throw) and still fans out variant_gen', async () => {
    const db = testDb();
    await seedXuciKnowledge();
    await seedQuestion('q1');
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => ({ text: '不是 JSON', task_run_id: 'tr_perm' }));
    const enqueueVariantGen = vi.fn(async () => {});

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
      enqueueVariantGen,
    });
    // permanent is a completed attribution attempt — the job does not retry, and
    // the best-effort variant_gen fan-out still fires (idempotent, cause-gated).
    expect(result.status).toBe('attempted');
    expect(enqueueVariantGen).toHaveBeenCalledTimes(1);

    const judges = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(judges).toHaveLength(0);
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe('failed_permanent');
    expect(ledger[0].task_run_id).toBe('tr_perm');
  });
});
