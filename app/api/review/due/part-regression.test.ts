// T-QP (YUK-165) — review-due regression + part-surfacing test.
//
// Critical safety (spec §"Critical safety"): adding question_part must NOT change
// how a plain question is scheduled / surfaced. This test proves:
//   1. The plain-question due list is IDENTICAL with vs. without parts present.
//   2. A part (which IS a question row) with a failure attempt + FSRS state
//      surfaces in the due queue via the EXISTING path (subject_kind='question').
//
// db partition (imports @/db + tests/helpers/db).

import { questionPartRef } from '@/core/schema/activity';
import { event, material_fsrs_state, question } from '@/db/schema';
import { createQuestionPart } from '@/server/questions/parts';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const NOW = new Date();
const PAST_ISO = new Date(NOW.getTime() - 2 * 86400 * 1000).toISOString();

async function seedQuestion(id: string): Promise<void> {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `P ${id}`,
    reference_md: null,
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function seedFailureAttempt(questionId: string): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: `evt_attempt_${questionId}`,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: ['k1'] },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: NOW,
  });
}

async function seedFsrsState(questionId: string): Promise<void> {
  const db = testDb();
  await db.insert(material_fsrs_state).values({
    id: `f_${questionId}`,
    subject_kind: 'question',
    subject_id: questionId,
    state: {
      due: PAST_ISO,
      stability: 1.5,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state: 'review',
      last_review: null,
    } as never,
    due_at: new Date(PAST_ISO),
    last_review_event_id: null,
    updated_at: NOW,
  });
}

async function getDueIds(): Promise<string[]> {
  const res = await GET(new Request('http://localhost/api/review/due'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  return body.rows.map((r) => r.id);
}

describe('GET /api/review/due — question_part regression (T-QP)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('plain-question due list is identical with vs. without parts present', async () => {
    // Baseline: two plain due questions, no parts.
    await seedQuestion('q_due_a');
    await seedFsrsState('q_due_a');
    await seedQuestion('q_due_b');
    await seedFsrsState('q_due_b');

    const baseline = await getDueIds();
    expect(baseline).toEqual(['q_due_a', 'q_due_b']);

    // Now add a multi-part question whose PARTS are NOT due (no FSRS state, no
    // failure attempt). They must not perturb the plain-question due list.
    const db = testDb();
    await seedQuestion('q_parent');
    await db.transaction(async (tx) => {
      await createQuestionPart(tx, {
        parentQuestionId: 'q_parent',
        partIndex: 0,
        promptMd: 'part a',
        source: 'manual',
        now: NOW,
      });
      await createQuestionPart(tx, {
        parentQuestionId: 'q_parent',
        partIndex: 1,
        promptMd: 'part b',
        source: 'manual',
        now: NOW,
      });
    });

    const withParts = await getDueIds();
    // Byte-identical: parts with no FSRS state and no failure attempt do not appear.
    expect(withParts).toEqual(baseline);
  });

  it('a part with a failure attempt + due FSRS state surfaces via the existing path', async () => {
    const db = testDb();
    await seedQuestion('q_parent');
    let partId = '';
    await db.transaction(async (tx) => {
      const created = await createQuestionPart(tx, {
        parentQuestionId: 'q_parent',
        partIndex: 0,
        promptMd: 'reviewable part',
        source: 'manual',
        now: NOW,
      });
      partId = created.questionId;
    });

    // The part is reviewed like any question — subject_kind='question', its own id.
    await seedFailureAttempt(partId);
    await seedFsrsState(partId);

    const ids = await getDueIds();
    expect(ids).toContain(partId);

    // Sanity: the part is addressable at the activity layer as a question_part ref,
    // while its storage/FSRS identity is the question id used above.
    expect(questionPartRef(partId)).toEqual({ kind: 'question_part', id: partId });
  });

  it('a never-reviewed part with only a failure attempt surfaces (never-reviewed slice)', async () => {
    const db = testDb();
    await seedQuestion('q_parent');
    let partId = '';
    await db.transaction(async (tx) => {
      const created = await createQuestionPart(tx, {
        parentQuestionId: 'q_parent',
        partIndex: 0,
        promptMd: 'failed part',
        source: 'manual',
        now: NOW,
      });
      partId = created.questionId;
    });
    await seedFailureAttempt(partId);

    const ids = await getDueIds();
    expect(ids).toContain(partId);
  });
});
