// Task #17 — variant_gen handler tests.

import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runVariantGen } from './variant_gen';

const VALID_VARIANT_OUTPUT = JSON.stringify({
  prompt_md: '辨析下列句中「之」的用法：「师道之不传也久矣」。',
  reference_md: '主谓之间，取消句子独立性。',
  difficulty: 3,
  reasoning: '针对用户混淆主谓间与结构助词的概念错误，再出一道主谓间例子。',
});

async function seedQuestion(opts: {
  id: string;
  source?: string;
  variant_depth?: number;
  root_question_id?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: 'short_answer',
    prompt_md: '「之」在「古之学者必有师」中的用法',
    reference_md: '结构助词，相当于"的"',
    source: opts.source ?? 'manual',
    knowledge_ids: ['k_xuci'],
    variant_depth: opts.variant_depth ?? 0,
    root_question_id: opts.root_question_id ?? null,
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

async function seedJudgeForAttempt(attemptId: string, category: string) {
  // Use runAttributionAndWriteJudgeEvent so the chained-event shape stays
  // consistent with production write path.
  const runTaskFn = vi.fn(async () => ({
    text: JSON.stringify({
      primary_category: category,
      secondary_categories: [],
      analysis_md: '...',
      confidence: 0.8,
    }),
  }));
  await runAttributionAndWriteJudgeEvent({
    db: testDb(),
    attemptEventId: attemptId,
    input: {
      prompt_md: 'p',
      reference_md: 'r',
      wrong_answer_md: 'w',
      knowledge_context: [],
    },
    referencedKnowledgeIds: ['k_xuci'],
    runTaskFn,
  });
}

async function seedKnowledge() {
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

describe('runVariantGen', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:attempt_not_found when attempt event missing', async () => {
    const runTaskFn = vi.fn();
    const result = await runVariantGen({
      db: testDb(),
      attemptEventId: 'no_such',
      runTaskFn,
    });
    expect(result.status).toBe('skipped:attempt_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:not_a_failure_attempt for success events', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await writeEvent(db, {
      id: attemptId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'success',
      payload: { answer_md: 'right', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: new Date(),
    });

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:not_a_failure_attempt');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:no_judge_yet when chained judge event missing', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:no_judge_yet');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:cause_not_targetable for carelessness cause', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'carelessness');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:cause_not_targetable');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:variant_chain_terminus when parent is itself a variant', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1', source: 'mistake_variant', variant_depth: 1 });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    // variant_chain_terminus checked before max_depth
    expect(result.status).toBe('skipped:variant_chain_terminus');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:max_depth when parent depth >= 1', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1', source: 'manual', variant_depth: 1 });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:max_depth');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('generates a depth=1 variant on the happy path', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('generated');
    expect(result.variant_question_id).toBeTruthy();
    expect(runTaskFn).toHaveBeenCalledTimes(1);

    const variantId = result.variant_question_id ?? '';
    const variant = (await db.select().from(question).where(eq(question.id, variantId)))[0];
    expect(variant.source).toBe('mistake_variant');
    expect(variant.draft_status).toBe('draft');
    expect(variant.variant_depth).toBe(1);
    expect(variant.parent_variant_id).toBe('q1');
    expect(variant.root_question_id).toBe('q1');
    expect(variant.knowledge_ids).toEqual(['k_xuci']);
    expect(variant.difficulty).toBe(3);
    expect(variant.source_ref).toBe(attemptId);
  });

  it('returns skipped:already_has_variant on re-run (idempotency)', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const first = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(first.status).toBe('generated');

    const second = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(second.status).toBe('skipped:already_has_variant');
    // LLM called only once
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('propagates an existing root_question_id (preserves variant lineage)', async () => {
    const db = testDb();
    await seedKnowledge();
    // Note: this is a synthetic edge case — we set root_question_id≠id on a
    // depth-0 question to verify the handler doesn't overwrite it. In
    // production, depth-0 questions always have root_question_id=null and
    // depth>=1 questions are blocked by max_depth.
    await seedQuestion({ id: 'q1', root_question_id: 'q_root' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('generated');
    const variantId = result.variant_question_id ?? '';
    const variant = (await db.select().from(question).where(eq(question.id, variantId)))[0];
    expect(variant.root_question_id).toBe('q_root');
  });

  it('throws when LLM output is not valid JSON', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));
    await expect(runVariantGen({ db, attemptEventId: attemptId, runTaskFn })).rejects.toThrow(
      /parseVariantOutput/,
    );
  });
});

describe('runAttributionFollowup → enqueueVariantGen wiring', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('invokes enqueueVariantGen with the attempt id after a successful run', async () => {
    const { runAttributionFollowup } = await import('./attribution_followup');
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '...',
        confidence: 0.8,
      }),
    }));
    const enqueueVariantGen = vi.fn(async () => {});

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
      enqueueVariantGen,
    });
    expect(result.status).toBe('attempted');
    expect(enqueueVariantGen).toHaveBeenCalledWith(attemptId);

    // The judge event chained off the attempt was indeed written
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

  it('does not invoke enqueueVariantGen when attempt is skipped', async () => {
    const { runAttributionFollowup } = await import('./attribution_followup');
    const enqueueVariantGen = vi.fn(async () => {});
    const runTaskFn = vi.fn();

    const result = await runAttributionFollowup({
      db: testDb(),
      attemptEventId: 'no_such',
      runTaskFn,
      enqueueVariantGen,
    });
    expect(result.status).toBe('skipped:attempt_not_found');
    expect(enqueueVariantGen).not.toHaveBeenCalled();
  });

  it('swallows enqueue errors (attribution result still succeeds)', async () => {
    const { runAttributionFollowup } = await import('./attribution_followup');
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '...',
        confidence: 0.8,
      }),
    }));
    const enqueueVariantGen = vi.fn(async () => {
      throw new Error('boss not reachable');
    });

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
      enqueueVariantGen,
    });
    expect(result.status).toBe('attempted');
    expect(enqueueVariantGen).toHaveBeenCalled();
  });
});
