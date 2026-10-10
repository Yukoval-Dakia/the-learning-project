// Task #17 — variant_gen handler tests.

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runAttributionAndWriteJudgeEvent } from './failure-learning-attribution';
import { runVariantGen } from './failure-learning-variant';

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

async function seedJudgeForAttempt(attemptId: string, category: string, domain = 'yuwen') {
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
    subjectProfile: resolveSubjectProfile(domain),
  });
}

async function seedKnowledge(domain = 'yuwen') {
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

describe('runVariantGen', () => {
  beforeEach(async () => {
    await resetDb();
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
    expect(first.status).toBe('proposed');

    const second = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(second.status).toBe('skipped:already_has_variant');
    // LLM called only once
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it.each(['accept', 'dismiss'] as const)(
    'does not regenerate after the same-attempt proposal is rated %s',
    async (rating) => {
      const db = testDb();
      await seedKnowledge();
      await seedQuestion({ id: 'q1' });
      const attemptId = createId();
      await seedFailureAttempt(attemptId, 'q1');
      await seedJudgeForAttempt(attemptId, 'concept');
      const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
      const first = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
      const proposalId = first.proposal_id;
      if (!proposalId) throw new Error('expected first proposal id');

      await db.insert(event).values({
        id: createId(),
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: { rating },
        caused_by_event_id: proposalId,
        created_at: new Date(),
      });

      await expect(runVariantGen({ db, attemptEventId: attemptId, runTaskFn })).resolves.toEqual({
        status: 'skipped:already_has_variant',
      });
      expect(runTaskFn).toHaveBeenCalledTimes(1);
    },
  );
});
