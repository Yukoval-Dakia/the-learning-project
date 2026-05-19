// Phase 1c.1 Step 4 → Step 9 — integration back-compat test for the mistake
// read-path.
//
// Seeds attempt + judge + review events (Lane B shapes) and verifies that the
// projections produced by the new server library match a hand-written
// mistake-shape baseline. Step 9 removed the legacy `mistake` table; this
// test now exclusively exercises the event-stream projection path.

import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { getFailureAttempts, getRecentReviewEvents } from '@/server/events/queries';
import { buildMistakesCsv, buildReviewEventsCsv } from '@/server/export/csv';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db';

const FIXTURE_TIME = new Date('2026-05-15T12:00:00Z');

async function seedFixture() {
  const db = testDb();
  // Two knowledge nodes
  await db.insert(knowledge).values([
    {
      id: 'k_concept',
      name: '概念',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: FIXTURE_TIME,
      updated_at: FIXTURE_TIME,
      version: 0,
    },
    {
      id: 'k_memory',
      name: '记忆',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: FIXTURE_TIME,
      updated_at: FIXTURE_TIME,
      version: 0,
    },
  ]);

  // One question
  await db.insert(question).values({
    id: 'q1',
    kind: 'short_answer',
    prompt_md: '解释 之 的用法',
    reference_md: '助词；代词；动词',
    knowledge_ids: ['k_concept', 'k_memory'],
    difficulty: 4,
    source: 'manual',
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    version: 0,
  });

  // Attempt event (failure) with chained judge
  const attemptId1 = 'evt_attempt_with_judge';
  await db.insert(event).values([
    {
      id: attemptId1,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: '助词',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_concept'],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(FIXTURE_TIME.getTime() + 0),
    },
    {
      id: 'evt_judge_for_attempt_1',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId1,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'knowledge_gap',
          secondary_categories: [],
          analysis_md: '用户没记住 之 在主谓之间的取消独立性用法',
          confidence: 0.82,
        },
        referenced_knowledge_ids: ['k_concept'],
      },
      caused_by_event_id: attemptId1,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(FIXTURE_TIME.getTime() + 60_000),
    },
    // Second attempt — no judge (still pending attribution)
    {
      id: 'evt_attempt_no_judge',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: '动词',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_memory'],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(FIXTURE_TIME.getTime() + 120_000),
    },
    // Review event after the first attempt
    {
      id: 'evt_review_1',
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
          due: new Date(FIXTURE_TIME.getTime() + 10 * 86_400_000).toISOString(),
          stability: 3,
          difficulty: 4,
          elapsed_days: 1,
          scheduled_days: 10,
          learning_steps: 0,
          reps: 2,
          lapses: 1,
          state: 'review',
          last_review: new Date(FIXTURE_TIME.getTime() + 180_000).toISOString(),
        },
        user_response_md: null,
        referenced_knowledge_ids: ['k_concept'],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(FIXTURE_TIME.getTime() + 180_000),
    },
  ]);

  // FSRS projection row
  await db.insert(material_fsrs_state).values({
    id: 'fsrs_q1',
    subject_kind: 'question',
    subject_id: 'q1',
    state: {
      due: new Date(FIXTURE_TIME.getTime() + 10 * 86_400_000),
      stability: 3,
      difficulty: 4,
      elapsed_days: 1,
      scheduled_days: 10,
      learning_steps: 0,
      reps: 2,
      lapses: 1,
      state: 'review',
      last_review: new Date(FIXTURE_TIME.getTime() + 180_000),
    },
    due_at: new Date(FIXTURE_TIME.getTime() + 10 * 86_400_000),
    last_review_event_id: 'evt_review_1',
    updated_at: new Date(FIXTURE_TIME.getTime() + 180_000),
  });
}

async function seedCorrectionEvent(opts: {
  id: string;
  target_event_id: string;
  correction_kind: 'retract' | 'mark_wrong' | 'restore' | 'supersede';
  replacement_event_id?: string;
  created_at: Date;
}) {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.target_event_id,
    outcome: 'success',
    payload: {
      correction_kind: opts.correction_kind,
      replacement_event_id: opts.replacement_event_id,
      reason_md: 'manual correction',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at,
  });
}

describe('integration: mistake read-path back-compat (event stream → mistake-shape projection)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('getFailureAttempts returns two attempts ordered desc; chained judge populated only on the first', async () => {
    await seedFixture();
    const db = testDb();
    const attempts = await getFailureAttempts(db);
    expect(attempts).toHaveLength(2);

    // Newest first (no_judge attempt is later)
    const noJudge = attempts[0];
    const withJudge = attempts[1];

    // Baseline JSON projection for "attempt with chained judge"
    const withJudgeBaseline = {
      attempt_event_id: 'evt_attempt_with_judge',
      question_id: 'q1',
      answer_md: '助词',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_concept'],
      judge_present: true,
      judge_primary_category: 'knowledge_gap',
      judge_analysis_md: '用户没记住 之 在主谓之间的取消独立性用法',
      judge_confidence: 0.82,
    };
    expect({
      attempt_event_id: withJudge.attempt_event_id,
      question_id: withJudge.question_id,
      answer_md: withJudge.answer_md,
      answer_image_refs: withJudge.answer_image_refs,
      referenced_knowledge_ids: withJudge.referenced_knowledge_ids,
      judge_present: withJudge.judge !== undefined,
      judge_primary_category: withJudge.judge?.cause.primary_category,
      judge_analysis_md: withJudge.judge?.cause.analysis_md,
      judge_confidence: withJudge.judge?.cause.confidence,
    }).toEqual(withJudgeBaseline);

    // Baseline JSON projection for "attempt without judge"
    const noJudgeBaseline = {
      attempt_event_id: 'evt_attempt_no_judge',
      question_id: 'q1',
      answer_md: '动词',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_memory'],
      judge_present: false,
    };
    expect({
      attempt_event_id: noJudge.attempt_event_id,
      question_id: noJudge.question_id,
      answer_md: noJudge.answer_md,
      answer_image_refs: noJudge.answer_image_refs,
      referenced_knowledge_ids: noJudge.referenced_knowledge_ids,
      judge_present: noJudge.judge !== undefined,
    }).toEqual(noJudgeBaseline);
  });

  it('getFailureAttempts and getRecentReviewEvents ignore corrected rows in active projections', async () => {
    await seedFixture();
    const db = testDb();
    await seedCorrectionEvent({
      id: 'evt_correct_attempt_no_judge',
      target_event_id: 'evt_attempt_no_judge',
      correction_kind: 'retract',
      created_at: new Date(FIXTURE_TIME.getTime() + 240_000),
    });
    await seedCorrectionEvent({
      id: 'evt_correct_judge_1',
      target_event_id: 'evt_judge_for_attempt_1',
      correction_kind: 'mark_wrong',
      created_at: new Date(FIXTURE_TIME.getTime() + 300_000),
    });
    await seedCorrectionEvent({
      id: 'evt_correct_review_1',
      target_event_id: 'evt_review_1',
      correction_kind: 'retract',
      created_at: new Date(FIXTURE_TIME.getTime() + 360_000),
    });

    const attempts = await getFailureAttempts(db);
    const reviews = await getRecentReviewEvents(db, { questionIds: ['q1'] });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt_event_id).toBe('evt_attempt_with_judge');
    expect(attempts[0].judge).toBeUndefined();
    expect(reviews).toHaveLength(0);
  });

  it('getRecentReviewEvents returns the seeded review with parsed FSRS state', async () => {
    await seedFixture();
    const db = testDb();
    const reviews = await getRecentReviewEvents(db, { questionIds: ['q1'] });
    expect(reviews).toHaveLength(1);
    const r = reviews[0];
    expect(r.fsrs_rating).toBe('good');
    expect(r.outcome).toBe('success');
    expect(r.fsrs_state_after.reps).toBe(2);
    expect(r.fsrs_state_after.lapses).toBe(1);
  });

  it('CSV event-stream projection produces one row per failure attempt with judge cause column populated', async () => {
    await seedFixture();
    const db = testDb();
    // Pull raw event rows + supporting tables as the export route would
    const events = await db.select().from(event);
    const questions = await db.select().from(question);
    const knowledgeRows = await db.select().from(knowledge);
    const fsrs = await db.select().from(material_fsrs_state);

    const csv = buildMistakesCsv({
      knowledge: knowledgeRows as unknown as Record<string, unknown>[],
      question: questions.map((q) => ({
        ...q,
        knowledge_ids: JSON.stringify(q.knowledge_ids),
      })) as unknown as Record<string, unknown>[],
      event: events as unknown as Record<string, unknown>[],
      material_fsrs_state: fsrs as unknown as Record<string, unknown>[],
    });

    const lines = csv.split('\n');
    expect(lines.length).toBe(3); // header + 2 attempts
    // Both attempt ids appear in CSV
    expect(csv).toContain('evt_attempt_with_judge');
    expect(csv).toContain('evt_attempt_no_judge');
    // Judge cause primary_category column populated for attempt with judge
    expect(csv).toContain('knowledge_gap');
  });

  it('CSV review-events event-stream projection includes the seeded review with again→failure outcome semantics', async () => {
    await seedFixture();
    const db = testDb();
    const events = await db.select().from(event);
    const questions = await db.select().from(question);
    const knowledgeRows = await db.select().from(knowledge);

    const csv = buildReviewEventsCsv({
      knowledge: knowledgeRows as unknown as Record<string, unknown>[],
      question: questions.map((q) => ({
        ...q,
        knowledge_ids: JSON.stringify(q.knowledge_ids),
      })) as unknown as Record<string, unknown>[],
      event: events as unknown as Record<string, unknown>[],
    });

    const lines = csv.split('\n');
    expect(lines.length).toBe(2); // header + 1 review
    expect(csv).toContain('evt_review_1');
    expect(csv).toContain(',good,');
  });
});
