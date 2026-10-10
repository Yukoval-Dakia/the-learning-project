// Task #16 — attribution_followup handler tests.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runAttributionFollowup } from './attribution_followup';

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

  it('is idempotent — re-running after a judge already exists is a no-op', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'k_xuci',
      name: '虚词',
      domain: 'yuwen',
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
    const enqueueVariantGen = vi.fn(async () => {});

    await runAttributionFollowup({ db, attemptEventId: attemptId, runTaskFn, enqueueVariantGen });
    await runAttributionFollowup({ db, attemptEventId: attemptId, runTaskFn, enqueueVariantGen });

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
    expect(enqueueVariantGen).toHaveBeenCalledTimes(2);
  });
});
