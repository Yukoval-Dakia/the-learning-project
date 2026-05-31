// P5.6 / YUK-178 — active-question + cumulative attempt-count helper (call-site
// 11, §4.3, PIN 7/8). Backs the turn/GET response data that drives the drawer's
// corrective redo chip.

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';

import { resetDb, testDb } from '../../../tests/helpers/db';
import { countAttemptOutcomes, getActiveQuestionState } from './active-question';

async function seedTeachingQuestion(sessionId: string, createdAt: Date): Promise<string> {
  const db = testDb();
  const id = createId();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'q',
    reference_md: 'r',
    knowledge_ids: [],
    difficulty: 2,
    source: 'teaching_check',
    source_ref: createId(),
    metadata: { session_id: sessionId, learning_item_id: 'li_x' },
    created_at: createdAt,
    updated_at: createdAt,
  });
  return id;
}

async function seedAttempt(questionId: string, outcome: 'success' | 'failure' | 'partial') {
  const db = testDb();
  const id = createId();
  await writeEvent(db, {
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome,
    payload: { answer_md: 'a', answer_image_refs: [], referenced_knowledge_ids: [] },
  });
}

describe('countAttemptOutcomes (PIN 7 — plain helper, no ToolContext)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('counts cumulative per-outcome totals over the timeline', async () => {
    const qid = await seedTeachingQuestion('sess_count', new Date());
    await seedAttempt(qid, 'failure');
    await seedAttempt(qid, 'failure');
    await seedAttempt(qid, 'success');
    await seedAttempt(qid, 'partial');
    await seedAttempt(qid, 'failure');

    const counts = await countAttemptOutcomes(testDb(), qid);
    expect(counts).toEqual({ success: 1, partial: 1, failure: 3 });
  });

  it('returns zeros for a question with no attempts', async () => {
    const qid = await seedTeachingQuestion('sess_zero', new Date());
    const counts = await countAttemptOutcomes(testDb(), qid);
    expect(counts).toEqual({ success: 0, partial: 0, failure: 0 });
  });

  it('counts the cumulative failure total past the old timeline window (P5.6 regression)', async () => {
    // 12 failures > the windowed reader's default cap of 10: the windowed
    // implementation reported 10 here, letting the failure total drop below the
    // N=3 trigger once a question accumulated history. The cumulative reader
    // must return all 12.
    const qid = await seedTeachingQuestion('sess_window', new Date());
    for (let i = 0; i < 12; i += 1) await seedAttempt(qid, 'failure');

    const counts = await countAttemptOutcomes(testDb(), qid);
    expect(counts.failure).toBe(12);
  });
});

describe('getActiveQuestionState (call-site 11, §4.3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null id + null counts when the session has no teaching_check question (PIN 8 question-creation turn)', async () => {
    const state = await getActiveQuestionState(testDb(), 'sess_none');
    expect(state).toEqual({ active_question_id: null, attempt_counts: null });
  });

  it('returns the latest teaching_check question for the session + its failure total', async () => {
    const older = await seedTeachingQuestion('sess_latest', new Date(Date.now() - 60_000));
    const newer = await seedTeachingQuestion('sess_latest', new Date());
    // attempts on the newer (active) question — the trigger reads this total
    await seedAttempt(newer, 'failure');
    await seedAttempt(newer, 'failure');
    await seedAttempt(newer, 'failure');
    // a stray attempt on the older question must NOT leak into the active count
    await seedAttempt(older, 'failure');

    const state = await getActiveQuestionState(testDb(), 'sess_latest');
    expect(state.active_question_id).toBe(newer);
    expect(state.attempt_counts).toEqual({ success: 0, partial: 0, failure: 3 });
  });

  it('does not return a question belonging to a different session', async () => {
    await seedTeachingQuestion('sess_other', new Date());
    const state = await getActiveQuestionState(testDb(), 'sess_mine');
    expect(state.active_question_id).toBeNull();
  });
});
