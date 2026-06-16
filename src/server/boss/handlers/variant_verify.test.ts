// YUK-17 / ADR-0018 — variant_verify handler tests.

import { runAttributionAndWriteJudgeEvent } from '@/capabilities/knowledge/server/attribute';
import { event, knowledge, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { writeVariantQuestionProposal } from '@/server/proposals/producers';
import { resolveSubjectProfile } from '@/subjects/profile';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runVariantVerify } from './variant_verify';

const PASS_OUTPUT = JSON.stringify({
  verdict: 'pass',
  failure_reasons: [],
  cause_targeting: 'on_target',
  summary_md: '变式覆盖了"之-主谓间"概念，难度与原题接近。',
  confidence: 0.82,
});

const FAIL_OUTPUT = JSON.stringify({
  verdict: 'fail',
  failure_reasons: ['变式的提问指向"之-定语后置标志"，已偏离原 cause 的主谓间用法', '难度跳跃过大'],
  cause_targeting: 'off_target',
  summary_md: '变式飘到了无关知识点，无法重现 cause。',
  confidence: 0.78,
});

async function seedKnowledge(domain = 'wenyan') {
  await testDb().insert(knowledge).values({
    id: 'k_xuci',
    name: '虚词',
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
}

async function seedParentAndVariant(opts: {
  parentId: string;
  variantId: string;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.parentId,
    kind: 'short_answer',
    prompt_md: '「之」在「古之学者必有师」中的用法',
    reference_md: '结构助词，相当于"的"',
    knowledge_ids: ['k_xuci'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    root_question_id: null,
    created_at: now,
    updated_at: now,
  });
  await db.insert(question).values({
    id: opts.variantId,
    kind: 'short_answer',
    prompt_md: '辨析「师道之不传也久矣」中"之"的用法。',
    reference_md: '主谓之间，取消句子独立性。',
    knowledge_ids: ['k_xuci'],
    difficulty: 3,
    source: 'mistake_variant',
    draft_status: 'active',
    variant_depth: 1,
    root_question_id: opts.parentId,
    parent_variant_id: opts.parentId,
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
    subjectProfile: resolveSubjectProfile('wenyan'),
  });
}

async function seedUserCause(attemptId: string, category: string, notes: string) {
  await writeEvent(testDb(), {
    id: createId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      primary_category: category,
      user_notes: notes,
    },
    caused_by_event_id: attemptId,
    created_at: new Date(),
  });
}

async function seedActiveMistakeVariant(opts: {
  parentId: string;
  variantId: string;
  attemptId: string;
}) {
  const db = testDb();
  // 1) parent + variant questions
  await seedParentAndVariant({ parentId: opts.parentId, variantId: opts.variantId });
  // 2) failure attempt + judge
  await seedFailureAttempt(opts.attemptId, opts.parentId);
  await seedJudgeForAttempt(opts.attemptId, 'concept');
  // 3) variant_question proposal (so we have a proposal_event_id pointing
  // at a real event with the right ai_proposal payload shape)
  const proposalId = await writeVariantQuestionProposal(db, {
    source_question_id: opts.parentId,
    source_attempt_event_id: opts.attemptId,
    prompt_md: '辨析「师道之不传也久矣」中"之"的用法。',
    reference_md: '主谓之间，取消句子独立性。',
    difficulty: 3,
    knowledge_ids: ['k_xuci'],
    parent_variant_id: opts.parentId,
    root_question_id: opts.parentId,
    variant_depth: 1,
    reason_md: '针对主谓间用法的针对性变式',
  });
  // 4) mistake_variant row at status='active' with variant_question_id set
  const mvId = createId();
  const now = new Date();
  await db.insert(mistake_variant).values({
    id: mvId,
    parent_question_id: opts.parentId,
    variant_question_id: opts.variantId,
    proposal_event_id: proposalId,
    status: 'active',
    failure_reasons: [],
    cause_category: 'concept',
    created_at: now,
    updated_at: now,
  });
  return { mvId, proposalId };
}

describe('runVariantVerify', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:not_found when mistake_variant row is missing', async () => {
    const runTaskFn = vi.fn();
    const result = await runVariantVerify({
      db: testDb(),
      mistakeVariantId: 'no_such',
      runTaskFn,
    });
    expect(result.status).toBe('skipped:not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:not_active when row status is draft', async () => {
    await seedKnowledge();
    const db = testDb();
    const mvId = createId();
    const now = new Date();
    await db.insert(mistake_variant).values({
      id: mvId,
      parent_question_id: 'q_parent',
      variant_question_id: null,
      proposal_event_id: 'p1',
      status: 'draft',
      failure_reasons: [],
      cause_category: 'concept',
      created_at: now,
      updated_at: now,
    });
    const runTaskFn = vi.fn();
    const result = await runVariantVerify({
      db,
      mistakeVariantId: mvId,
      runTaskFn,
    });
    expect(result.status).toBe('skipped:not_active');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('happy path: verdict=pass leaves status active and writes verify event', async () => {
    await seedKnowledge();
    const { mvId, proposalId } = await seedActiveMistakeVariant({
      parentId: 'q_parent',
      variantId: 'q_variant',
      attemptId: createId(),
    });

    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    const result = await runVariantVerify({
      db: testDb(),
      mistakeVariantId: mvId,
      runTaskFn,
    });

    expect(result.status).toBe('verified');
    expect(result.cause_targeting).toBe('on_target');
    expect(runTaskFn).toHaveBeenCalledTimes(1);

    const rows = await testDb().select().from(mistake_variant).where(eq(mistake_variant.id, mvId));
    expect(rows[0].status).toBe('active');
    expect(rows[0].failure_reasons).toEqual([]);

    const verifyEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:variant_verify'));
    expect(verifyEvents).toHaveLength(1);
    expect(verifyEvents[0]).toMatchObject({
      subject_kind: 'question',
      subject_id: 'q_variant',
      outcome: 'success',
      caused_by_event_id: proposalId,
    });
    expect(verifyEvents[0].payload).toMatchObject({
      verdict: 'pass',
      cause_targeting: 'on_target',
      mistake_variant_id: mvId,
    });
    // YUK-350 (L3, RL5) — a 'pass' verify carries NO failure_class.
    expect((verifyEvents[0].payload as Record<string, unknown>).failure_class).toBeUndefined();
  });

  it('drift path: verdict=fail flips status to broken with failure_reasons', async () => {
    await seedKnowledge();
    const { mvId } = await seedActiveMistakeVariant({
      parentId: 'q_parent',
      variantId: 'q_variant',
      attemptId: createId(),
    });

    const runTaskFn = vi.fn(async () => ({ text: FAIL_OUTPUT }));
    const result = await runVariantVerify({
      db: testDb(),
      mistakeVariantId: mvId,
      runTaskFn,
    });

    expect(result.status).toBe('broken');
    expect(result.failure_reasons).toEqual([
      '变式的提问指向"之-定语后置标志"，已偏离原 cause 的主谓间用法',
      '难度跳跃过大',
    ]);

    const rows = await testDb().select().from(mistake_variant).where(eq(mistake_variant.id, mvId));
    expect(rows[0].status).toBe('broken');
    expect(rows[0].failure_reasons).toEqual([
      '变式的提问指向"之-定语后置标志"，已偏离原 cause 的主谓间用法',
      '难度跳跃过大',
    ]);

    // YUK-350 (L3, RL5) — a 'fail' verdict (outcome 'partial') carries
    // failure_class='validation_failure'.
    const verifyEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:variant_verify'));
    expect(verifyEvents).toHaveLength(1);
    expect(verifyEvents[0].outcome).toBe('partial');
    expect((verifyEvents[0].payload as Record<string, unknown>).failure_class).toBe(
      'validation_failure',
    );
  });

  it('idempotency: re-running after pass short-circuits without calling LLM', async () => {
    await seedKnowledge();
    const { mvId } = await seedActiveMistakeVariant({
      parentId: 'q_parent',
      variantId: 'q_variant',
      attemptId: createId(),
    });

    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    const first = await runVariantVerify({
      db: testDb(),
      mistakeVariantId: mvId,
      runTaskFn,
    });
    expect(first.status).toBe('verified');

    const second = await runVariantVerify({
      db: testDb(),
      mistakeVariantId: mvId,
      runTaskFn,
    });
    expect(second.status).toBe('skipped:already_verified');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('CC-1: prefers active user_cause over agent judge when building input', async () => {
    await seedKnowledge();
    const attemptId = createId();
    const { mvId } = await seedActiveMistakeVariant({
      parentId: 'q_parent',
      variantId: 'q_variant',
      attemptId,
    });
    // Override the judge with a user_cause — effectiveCauseForFailureAttempt
    // returns the user_cause first per CC-1.
    await seedUserCause(attemptId, 'concept', '用户确认是主谓间概念混淆');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: PASS_OUTPUT,
    }));
    await runVariantVerify({
      db: testDb(),
      mistakeVariantId: mvId,
      runTaskFn,
    });

    const input = runTaskFn.mock.calls[0]?.[1] as {
      original_cause?: { primary_category?: string; source?: string; analysis_md?: string };
    };
    expect(input.original_cause?.primary_category).toBe('concept');
    expect(input.original_cause?.source).toBe('user');
    expect(input.original_cause?.analysis_md).toBe('用户确认是主谓间概念混淆');
  });

  it('throws when LLM output is not valid JSON', async () => {
    await seedKnowledge();
    const { mvId } = await seedActiveMistakeVariant({
      parentId: 'q_parent',
      variantId: 'q_variant',
      attemptId: createId(),
    });

    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));
    await expect(
      runVariantVerify({ db: testDb(), mistakeVariantId: mvId, runTaskFn }),
    ).rejects.toThrow(/parseVariantVerifyOutput/);
  });
});
