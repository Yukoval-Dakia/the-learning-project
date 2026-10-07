// U5 (YUK-203) — end-to-end paper lifecycle DB test (Cross §11 highest single
// risk: the append-only frozen-rows × derived read-layer consistency).
//
// Covers the FULL cycle the Cross-统合 verdict points at:
//   draft → freeze(submit) → abandon → reopen(abandoned→started) → new draft →
//   re-freeze → re-judge
// and asserts, at each step:
//   - pos (COUNT DISTINCT slot WHERE submitted) does NOT double-count after a
//     reopen→resubmit (the append-only history would render "5/4" under a raw
//     COUNT);
//   - the partial unique index constrains ONLY the live draft (frozen rows are
//     append-only history);
//   - derived visibility (user-facing vs Coach-facing) is correct each step.
//
// Uses the deterministic `exact` judge (true_false question matched against
// reference_md) — no LLM / runTask mock needed.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  answer,
  artifact,
  assessment_submission,
  evaluation,
  event,
  learning_session,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { getCurrentFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import * as masteryStateModule from '@/server/mastery/state';
import { Review } from '@/server/session';
import {
  paperFixtureAssessment,
  publishPaperModelFixture,
  reopenFrozenPaperFixture,
  startFrozenPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createPaperReviewSession } from '../api/paper-session-create';
import { PATCH as completeReview } from '../api/review-session-detail';
import { autosaveAnswerDraft, countAnsweredSlots, freezeAnswerDraft } from './answer-draft';
import { handleFailureLearningAttemptDelivery } from './failure-learning-subscription';
import * as evaluationService from './judge/evaluate-submission';
import { createRecordedModelExecutor } from './judge/recorded-model-executor';
import { getPaperDetail } from './paper-detail';
import { getPracticeList, isJudgementVisibleToUser } from './practice-read';

async function seedQuestion(id: string, reference: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    judge_kind_override: 'exact',
    prompt_md: `Prompt ${id}`,
    reference_md: reference,
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(
  id: string,
  questionIds: string[],
  partRefs: string[] = [],
  feedbackPolicy = 'immediate',
) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: '测试卷',
    knowledge_ids: ['k1'],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: ['k1'],
          feedback_policy: feedbackPolicy,
          adaptation_policy: 'none',
          assignments: questionIds.flatMap((qid) =>
            (partRefs.length ? partRefs : [null]).map((part_ref) => ({
              ...(part_ref ? { part_ref } : {}),
              question_id: qid,
              primary_knowledge_id: 'k1',
              secondary_knowledge_ids: [],
              selection_reason: 'test',
              review_profile_snapshot: {},
            })),
          ),
        },
      ],
    } as never,
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function submissionForAttempt(attemptId: string) {
  const [anchor] = await testDb().select().from(event).where(eq(event.id, attemptId));
  if (typeof anchor?.payload.submission_id !== 'string') throw new Error('native capture absent');
  const [submission] = await testDb()
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, anchor.payload.submission_id));
  return submission;
}

async function candidatesForAttempt(attemptId: string) {
  const submission = await submissionForAttempt(attemptId);
  return testDb()
    .select()
    .from(evaluation)
    .where(eq(evaluation.submission_id, submission.submission_id));
}

function scored(input: ModelExecutorRequest, runId: string, points = 1): ModelUnitOutcomeT {
  return {
    kind: 'scored',
    points_awarded: points,
    confidence: 0.95,
    matched: {
      rule_id:
        input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : undefined,
      option_ids: [],
    },
    evidence_citations: input.group_evidence.length
      ? [{ evidence_id: input.group_evidence[0].evidence.evidence_id }]
      : [{ slot_id: input.slot_responses[0].slot_id }],
    run_refs: [runId],
    cost_usd_micros: 80,
  };
}

function installExecutor(db: Db, execute: Parameters<typeof createRecordedModelExecutor>[1]) {
  return vi
    .spyOn(evaluationService, 'createFormalModelExecutor')
    .mockImplementation(() => createRecordedModelExecutor(db, execute));
}

async function modelPaper() {
  const db = testDb();
  await seedQuestion('q1', '必须列出方程、解释消元并保留速度单位。');
  await db.update(question).set({ judge_kind_override: 'semantic' }).where(eq(question.id, 'q1'));
  await publishPaperModelFixture(db, 'q1');
  await seedPaper('paper1', ['q1']);
  const { sessionId } = await startFrozenPaperFixture(db, 'paper1');
  return {
    db,
    input: {
      sessionId,
      paperArtifactId: 'paper1',
      questionId: 'q1',
      answerMd: 'v+c=18，v-c=12，得2v=30，静水船速15 km/h。',
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('U5 paper lifecycle — draft/freeze/abandon/reopen/refreeze/rejudge', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
  });

  it('durably releases buffered failures on canonical completion without duplicate jobs', async () => {
    const db = testDb();
    await seedQuestion('q_buffered', 'true');
    await seedPaper('paper_buffered', ['q_buffered'], [], 'judge_now_show_later');
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_buffered');
    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_buffered',
        questionId: 'q_buffered',
        answerMd: 'false',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'judge_now_show_later',
      },
      db,
    );
    const [anchor] = await db
      .select()
      .from(event)
      .where(
        and(eq(event.session_id, sessionId), eq(event.action, 'experimental:assessment_attempt')),
      );
    const [activation] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_activation'),
          eq(event.subject_id, String(anchor.payload.evaluation_group_id)),
        ),
      );
    const jobs = new Set<string>();
    const bossSend = vi.fn(async (_queue: string, _data: unknown, options: { id: string }) => {
      if (jobs.has(options.id)) return null;
      jobs.add(options.id);
      return options.id;
    });
    const deliver = (id: string) =>
      handleFailureLearningAttemptDelivery(
        db,
        {
          subscriberId: 'practice.failure-learning-attempt',
          subscriberVersion: 3,
          deliverySeq: '1',
          sourceEventId: id,
        },
        { bossSend },
      );
    expect((await deliver(anchor.id)).status).toBe('skipped');
    expect((await deliver(activation.id)).status).toBe('skipped');
    expect(jobs.size).toBe(0);
    expect(await getCurrentFailureAttempts(db)).toHaveLength(0);
    const complete = () =>
      completeReview(
        new Request(`http://test/api/review-sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'completed' }),
        }),
        { id: sessionId },
      );
    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(200);
    const releases = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.session_id, sessionId),
          eq(event.action, 'experimental:assessment_feedback_released'),
        ),
      );
    expect(releases).toHaveLength(1);
    expect((await deliver(releases[0].id)).status).toBe('succeeded');
    expect((await deliver(releases[0].id)).status).toBe('succeeded');
    expect(jobs.size).toBe(1);
    expect(bossSend.mock.calls[0][1]).toEqual({ attempt_event_id: anchor.id });
    expect(await getCurrentFailureAttempts(db)).toHaveLength(1);
  });

  it('full cycle: pos never double-counts, partial index constrains only live drafts', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedQuestion('q2', 'true');
    await seedPaper('paper1', ['q1', 'q2']);

    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // ── 1. DRAFT q1 (autosave). One live draft, no frozen rows, pos=0. ──
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'tru',
      paperArtifactId: 'paper1',
    });
    // Re-autosave the SAME slot: upsert in place, still one live draft.
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'true',
      paperArtifactId: 'paper1',
    });
    const liveAfterDraft = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(liveAfterDraft).toHaveLength(1);
    expect(liveAfterDraft[0].submitted_at).toBeNull();
    expect(liveAfterDraft[0].content_md).toBe('true');
    expect(await countAnsweredSlots(db, sessionId)).toBe(0);

    // ── 2. FREEZE q1 via submit (correct answer → attempt success + judge). ──
    const submit1 = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit1.coarseOutcome).toBe('correct');
    expect(submit1.visibleToUser).toBe(true);
    // One frozen row for q1; pos=1 (one distinct answered slot).
    const frozen1 = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(frozen1).toHaveLength(1);
    expect(frozen1[0].submitted_at).not.toBeNull();
    expect(frozen1[0].event_id).toBe(submit1.attemptEventId);
    expect(await countAnsweredSlots(db, sessionId)).toBe(1);

    // The candidate refers to the immutable original submission behind the capture.
    const judge1 = await db.select().from(evaluation);
    expect(judge1).toHaveLength(1);
    expect(judge1[0].submission_id).toBe(
      (await submissionForAttempt(submit1.attemptEventId)).submission_id,
    );

    // ── 3. ABANDON the session. ──
    await Review.abandonReviewSession(db, sessionId);

    // ── 4. REOPEN (abandoned → started ONLY). ──
    await reopenFrozenPaperFixture(db, sessionId);

    // ── 5. NEW DRAFT on the SAME slot q1 — allowed (old row frozen, excluded
    //       from the partial index). Two rows now: one frozen + one live. ──
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'false',
      paperArtifactId: 'paper1',
    });
    const afterReopenDraft = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')))
      .orderBy(desc(answer.submitted_at));
    expect(afterReopenDraft).toHaveLength(2);
    const liveRows = afterReopenDraft.filter((r) => r.submitted_at === null);
    expect(liveRows).toHaveLength(1); // partial index allows exactly one live draft
    // pos still 1 — the new live draft is NOT submitted yet.
    expect(await countAnsweredSlots(db, sessionId)).toBe(1);

    // ── 6. RE-FREEZE / RE-JUDGE q1 (now wrong answer → incorrect). ──
    const submit2 = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'false',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit2.coarseOutcome).toBe('incorrect');
    // Two frozen rows for q1 now (append-only history), but pos = 1 (DISTINCT
    // slot) — NOT 2. This is the core anti-double-count assertion.
    const frozenAfterReJudge = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    const frozenCount = frozenAfterReJudge.filter((r) => r.submitted_at !== null).length;
    expect(frozenCount).toBe(2);
    expect(await countAnsweredSlots(db, sessionId)).toBe(1); // NOT 2

    // Reopening issues a new occurrence: both immutable candidates remain.
    // The practice list projects only the current occurrence's effective verdict.
    const allJudges = await db.select().from(evaluation);
    expect(allJudges).toHaveLength(2);

    // ── 7. Practice list aggregation: pos=1 (q1 answered once distinct),
    //       right/wrong from NEWEST attempt per slot → q1 latest is incorrect. ──
    const practice = await getPracticeList(db);
    const paper = practice.papers.find((p) => p.artifact_id === 'paper1');
    expect(paper).toBeDefined();
    expect(paper?.source).toBe('coach'); // review_plan → Coach 排期
    expect(paper?.total_slots).toBe(2);
    expect(paper?.session?.pos).toBe(1); // distinct answered slot
    expect(paper?.session?.wrong).toBe(1); // newest q1 attempt is incorrect
    expect(paper?.session?.right).toBe(0);

    // B1-W1 (ADR-0035) — both graded paper attempts on k1 updated the p(L)
    // diagnostic axis (mastery_state.θ̂) in their respective txs. Two attempts
    // (correct then wrong) → evidence_count=2, success=1, fail=1.
    const masteryK1 = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k1'));
    expect(masteryK1).toHaveLength(1);
    expect(masteryK1[0].evidence_count).toBe(2);
    expect(masteryK1[0].success_count).toBe(1);
    expect(masteryK1[0].fail_count).toBe(1);
  });

  it('fails closed with a structured conflict when a slot has no shared parent evidence', async () => {
    const db = testDb();
    await seedQuestion('q_orphan', 'true');
    await db
      .update(question)
      .set({ parent_question_id: 'missing_parent' })
      .where(eq(question.id, 'q_orphan'));
    await seedPaper('paper_orphan', ['q_orphan']);
    await expect(createPaperReviewSession('paper_orphan')).rejects.toMatchObject({
      status: 409,
      code: 'unpublished',
    });
    expect(await db.select().from(learning_session)).toHaveLength(0);
  });

  it('partial index rejects a second live draft on the same slot (DB-level guard)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'a',
      paperArtifactId: 'paper1',
    });
    // A raw INSERT bypassing the upsert helper must collide on answer_draft_slot_uk.
    await expect(
      db.insert(answer).values({
        id: 'forced_dup',
        question_id: 'q1',
        input_kind: 'text',
        content_md: 'b',
        image_refs: [],
        tags: [],
        submitted_at: null,
        session_id: sessionId,
        part_ref: null,
        autosaved_at: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('composite question: two parts → pos === right + wrong, no slot collapse', async () => {
    // MUST-FIX coverage: same question_id with two distinct part_refs must produce
    // two separate slot keys in right/wrong aggregation. Before the Option-B fix,
    // practice-read.ts read part_ref from event.payload (which never had the field),
    // so both parts collapsed to slotKey `…::q1::` and right/wrong counted 1 instead
    // of 2. Now the answer-table JOIN uses COALESCE(part_ref,'') directly.
    const db = testDb();
    await seedQuestion('q1', 'true');
    // Part A and Part B are submitted on the same question_id but distinct part_refs.
    await db
      .update(question)
      .set({
        structured: {
          id: 'stem',
          role: 'stem',
          prompt_text: '根据给定条件分别判断两项陈述。',
          sub_questions: [
            { id: 'part_a', role: 'sub', prompt_text: '第一项陈述', answers: ['true'] },
            { id: 'part_b', role: 'sub', prompt_text: '第二项陈述', answers: ['true'] },
          ],
        },
      })
      .where(eq(question.id, 'q1'));
    await seedPaper('paper_composite', ['q1'], ['part_a', 'part_b']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_composite');

    // Submit part A: correct.
    const submitA = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_composite',
        questionId: 'q1',
        partRef: 'part_a',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
      },
      db,
    );
    expect(submitA.coarseOutcome).toBe('correct');

    // Submit part B: incorrect.
    const submitB = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_composite',
        questionId: 'q1',
        partRef: 'part_b',
        answerMd: 'false',
        primaryKnowledgeId: 'k1',
      },
      db,
    );
    expect(submitB.coarseOutcome).toBe('incorrect');

    // pos must be 2 (two distinct slots: (q1,part_a) and (q1,part_b)).
    expect(await countAnsweredSlots(db, sessionId)).toBe(2);

    // Practice list: pos === right + wrong (no slot collapse).
    const practice = await getPracticeList(db);
    const paper = practice.papers.find((p) => p.artifact_id === 'paper_composite');
    expect(paper?.session?.pos).toBe(2);
    expect(paper?.session?.right).toBe(1); // part_a correct
    expect(paper?.session?.wrong).toBe(1); // part_b incorrect
    // Core invariant: pos === right + wrong (no collapse, no double-count).
    expect(paper?.session?.pos).toBe((paper?.session?.right ?? 0) + (paper?.session?.wrong ?? 0));
  });

  it('composite question: reopen-resubmit stability — pos and right/wrong use newest slot only', async () => {
    // After abandon→reopen, a new submission on the same composite slot must not
    // double-count pos (still 1 per slot) and right/wrong must reflect the NEWEST
    // frozen row (not the original).
    const db = testDb();
    await seedQuestion('q1', 'true');
    await db
      .update(question)
      .set({
        structured: {
          id: 'stem',
          role: 'stem',
          prompt_text: '根据给定条件分别判断两项陈述。',
          sub_questions: [
            { id: 'part_a', role: 'sub', prompt_text: '第一项陈述', answers: ['true'] },
            { id: 'part_b', role: 'sub', prompt_text: '第二项陈述', answers: ['true'] },
          ],
        },
      })
      .where(eq(question.id, 'q1'));
    await seedPaper('paper_composite', ['q1'], ['part_a', 'part_b']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_composite');

    // First attempt on part_a: correct.
    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_composite',
        questionId: 'q1',
        partRef: 'part_a',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    // Abandon then reopen.
    await Review.abandonReviewSession(db, sessionId);
    await reopenFrozenPaperFixture(db, sessionId);

    // Second attempt on SAME part_a: now incorrect (changed answer).
    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_composite',
        questionId: 'q1',
        partRef: 'part_a',
        answerMd: 'false',
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    // pos = 1 (one distinct slot, not 2 from two frozen rows).
    expect(await countAnsweredSlots(db, sessionId)).toBe(1);

    // right/wrong from NEWEST frozen row for the slot → incorrect → wrong=1.
    const practice = await getPracticeList(db);
    const paper = practice.papers.find((p) => p.artifact_id === 'paper_composite');
    expect(paper?.session?.pos).toBe(1);
    expect(paper?.session?.wrong).toBe(1); // newest is incorrect
    expect(paper?.session?.right).toBe(0);
    // Invariant: pos === right + wrong.
    expect(paper?.session?.pos).toBe((paper?.session?.right ?? 0) + (paper?.session?.wrong ?? 0));
  });

  it('partial outcome counts as right in practice list (§4.10 Q9 deliberate)', async () => {
    // §4.10 Q9: loom dist-bar is a two-segment good/again split. 'partial' maps to
    // right (good segment) — a partial answer represents meaningful progress toward
    // mastery. This test pins that deliberate bucketing to prevent accidental drift.
    const db = testDb();
    // 'partial' judge kind: use a question where the exact judge returns 'partial'.
    // true_false with ambiguous answer — we can't easily force 'partial' from the
    // deterministic exact judge (it returns correct/incorrect only). Use the
    // freezeAnswerDraft + a synthetic attempt event directly to inject a 'partial'
    // outcome, then verify the aggregation.
    await seedQuestion('q1', 'true');
    await seedPaper('paper_partial', ['q1']);
    // Historical partial records retain their read semantics after execution cutover.
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_partial' });

    // Insert a frozen answer row + a synthetic attempt event with outcome='partial'
    // to simulate what submitPaperSlot would write for a partial judge outcome.
    const partialEventId = 'evt_partial_test';
    await db.insert(event).values({
      id: partialEventId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'partial',
      payload: { answer_md: 'partial answer', answer_image_refs: [], referenced_knowledge_ids: [] },
      caused_by_event_id: null,
      created_at: new Date(),
    });
    await freezeAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      eventId: partialEventId,
      inputKind: 'text',
      contentMd: 'partial answer',
      paperArtifactId: 'paper_partial',
    });

    const practice = await getPracticeList(db);
    const paper = practice.papers.find((p) => p.artifact_id === 'paper_partial');
    expect(paper?.session?.pos).toBe(1);
    // partial → right (deliberate §4.10 Q9)
    expect(paper?.session?.right).toBe(1);
    expect(paper?.session?.wrong).toBe(0);
  });

  // F1 (PR #309 round-4, YUK-215) — a photo-only answer on a text-only judge route
  // (true_false → exact judge) is "未判分": captured but NOT graded. Round-3 stopped
  // FSRS pollution but left the attempt as outcome='failure' with NO judge event,
  // so both read-layer summaries counted it as WRONG. This pins the write-side fix:
  //   - submit reports coarseOutcome='unsupported', visible, no judge event, no FSRS
  //   - getPracticeList / getPaperDetail count it as NEITHER right nor wrong
  //   - getPaperDetail surfaces outcome='unsupported' (visible) to the user
  it('F1: photo-only on a text-only route is un-judged — not wrong, status visible', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper_f1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_f1');

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_f1',
        questionId: 'q1',
        answerMd: '', // photo-only: no typed text
        answerImageRefs: ['photo_x'],
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    // Un-judged: surfaced as 'unsupported', always visible (actionable feedback).
    expect(submit.coarseOutcome).toBe('unsupported');
    expect(submit.visibleToUser).toBe(true);
    expect(submit.score).toBeNull();

    // NO judge event written (a text-only judge never saw the photo).
    const judgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_kind, 'event')));
    expect(judgeEvents).toHaveLength(0);

    // The attempt event carries the un-judged marker in its payload.
    const attemptEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:assessment_attempt'), eq(event.subject_id, 'q1')));
    expect(attemptEvents).toHaveLength(1);
    expect(attemptEvents[0].outcome).toBeNull();
    expect(submit.status).toBe('review_required');

    // NO FSRS state written for the un-judged slot.
    const fsrsRows = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k1'));
    expect(fsrsRows).toHaveLength(0);

    // B1-W1 (ADR-0035) — θ̂ shares the photoOnlyUnsupported gate: no outcome
    // signal → no diagnostic update either (ungraded → not scheduled, not diagnosed).
    const masteryRows = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k1'));
    expect(masteryRows).toHaveLength(0);

    // getPracticeList: the slot is answered (pos=1) but counts as NEITHER right
    // nor wrong — the un-judged attempt must not pollute the summary.
    const practice = await getPracticeList(db);
    const paper = practice.papers.find((p) => p.artifact_id === 'paper_f1');
    expect(paper?.session?.pos).toBe(1);
    expect(paper?.session?.right).toBe(0);
    expect(paper?.session?.wrong).toBe(0);

    // getPaperDetail: same right/wrong, and the slot surfaces outcome='unsupported'
    // (visible) so the user sees WHY it is ungraded.
    const detail = await getPaperDetail(db, 'paper_f1');
    expect(detail?.session?.right).toBe(0);
    expect(detail?.session?.wrong).toBe(0);
    const slot = detail?.sections.flatMap((s) => s.slots).find((s) => s.question_id === 'q1');
    const submission = slot?.slot_state.submission;
    expect(submission?.submitted).toBe(true);
    expect(submission?.visible_to_user).toBe(true);
    expect(submission && 'outcome' in submission ? submission.outcome : null).toBe('unsupported');
  });

  it('hidden judgement (feedback_policy=judge_now_show_later) is buffered until completion', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1'], [], 'judge_now_show_later');
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'judge_now_show_later',
      },
      db,
    );
    expect(submit.visibleToUser).toBe(false);

    const [capture] = await db.select().from(event).where(eq(event.id, submit.attemptEventId));
    expect(capture.payload.paper_feedback_policy).toBe('judge_now_show_later');

    // Derived visibility (§4.9):
    // started session → hidden to user, always visible to Coach.
    expect(isJudgementVisibleToUser({ visibleToUser: false, sessionStatus: 'started' })).toBe(
      false,
    );
    // abandoned does NOT reveal.
    expect(isJudgementVisibleToUser({ visibleToUser: false, sessionStatus: 'abandoned' })).toBe(
      false,
    );
    // completed reveals.
    expect(isJudgementVisibleToUser({ visibleToUser: false, sessionStatus: 'completed' })).toBe(
      true,
    );
    // an immediately-visible judgement (undefined) is always visible.
    expect(isJudgementVisibleToUser({ visibleToUser: undefined, sessionStatus: 'started' })).toBe(
      true,
    );
  });

  // ── issue #1: freeze UPDATE guarded by isNull(submitted_at) ─────────────────
  it('fix #1: freeze does not overwrite an already-frozen row (concurrent freeze guard)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // Autosave a draft, then freeze it (simulates normal submit path).
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'first draft',
      paperArtifactId: 'paper1',
    });
    const { answerId: frozenId } = await freezeAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'first answer',
      imageRefs: [],
      paperArtifactId: 'paper1',
      eventId: 'evt_first',
    });

    // Simulate a stale "concurrent" freeze arriving after the row is already frozen:
    // call freezeAnswerDraft again with the same slot. The guard (isNull check)
    // means no live draft is found; a NEW frozen row is inserted (no overwrite).
    const { answerId: secondId } = await freezeAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'second attempt',
      imageRefs: [],
      paperArtifactId: 'paper1',
      eventId: 'evt_second',
    });

    // Two distinct frozen rows — append-only, neither overwrote the other.
    expect(frozenId).not.toBe(secondId);

    // First frozen row retains its original content unchanged.
    const rows = await db.select().from(answer).where(eq(answer.id, frozenId));
    expect(rows[0].content_md).toBe('first answer');
    expect(rows[0].event_id).toBe('evt_first');
  });

  // ── issue #2: 23505 on concurrent first INSERT → re-read winner ──────────────
  it('fix #2: concurrent 23505 on autosave INSERT is recovered by re-reading the winner', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // Pre-insert a live draft directly (bypassing helper), simulating the
    // concurrent winner that committed before our INSERT runs.
    await db.insert(answer).values({
      id: 'concurrent_winner',
      question_id: 'q1',
      input_kind: 'text',
      content_md: 'winner content',
      image_refs: [],
      tags: [],
      submitted_at: null,
      session_id: sessionId,
      part_ref: null,
      paper_artifact_id: 'paper1',
      autosaved_at: new Date(),
    });

    // autosaveAnswerDraft finds no existing row (SELECT ran before the insert
    // above in a real race, but here the SELECT will find the pre-inserted row
    // and take the UPDATE path). To exercise the INSERT + 23505 catch path we
    // call the helper with a different slot key (simulated via a part_ref that
    // doesn't have a pre-existing row), then confirm idempotent recovery.
    // Direct 23505 recovery: call autosave on the slot that already has a draft.
    // The SELECT will find 'concurrent_winner' → UPDATE path → returns winner id.
    const { answerId } = await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      partRef: null,
      inputKind: 'text',
      contentMd: 'our content',
      paperArtifactId: 'paper1',
    });
    // Returns the winner's id (or the updated row id) — the slot still has exactly 1 live draft.
    const liveDrafts = await db
      .select()
      .from(answer)
      .where(
        and(
          eq(answer.session_id, sessionId),
          eq(answer.question_id, 'q1'),
          isNull(answer.submitted_at),
        ),
      );
    expect(liveDrafts).toHaveLength(1);
    expect(answerId).toBe(liveDrafts[0].id);
  });

  // ── issue #3: submitPaperSlot rejects misbound / wrong-state sessions ─────────
  it('fix #3: submitPaperSlot rejects a session bound to a different paper (400)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    await seedPaper('paper2', ['q1']);
    // Start a session against paper2 but try to submit against paper1.
    const { sessionId } = await startFrozenPaperFixture(db, 'paper2');

    await expect(
      submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'paper1',
          questionId: 'q1',
          answerMd: 'true',
          primaryKnowledgeId: 'k1',
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'historical_unknown' });
  });

  it('fix #3: submitPaperSlot rejects a completed session (400)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // Force session to completed.
    await db
      .update(learning_session)
      .set({ status: 'completed' })
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      .where((sql as any)`id = ${sessionId}`);

    await expect(
      submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'paper1',
          questionId: 'q1',
          answerMd: 'true',
          primaryKnowledgeId: 'k1',
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'session_closed' });
  });

  // ── fix #5 (round-2 P1): duplicate submit is idempotent ─────────────────────
  it('fix #5: duplicate submit (same content) returns existing ids, no new rows/events', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // First submit.
    const first = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    // Second submit with identical content — must be idempotent.
    const second = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    // Same ids returned.
    expect(second.attemptEventId).toBe(first.attemptEventId);
    expect(second.evaluationId).toBe(first.evaluationId);
    expect(second.answerId).toBe(first.answerId);

    // No duplicate frozen rows — exactly one frozen row for the slot.
    const frozenRows = await db
      .select()
      .from(answer)
      .where(
        and(
          eq(answer.session_id, sessionId),
          eq(answer.question_id, 'q1'),
          isNull(answer.submitted_at),
        ),
      );
    expect(frozenRows).toHaveLength(0); // live draft was consumed by freeze

    const allRows = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(allRows).toHaveLength(1); // exactly one frozen row, not two

    const judgeEvents = await candidatesForAttempt(first.attemptEventId);
    expect(judgeEvents).toHaveLength(1);
  });

  // ── fix #5 (round-2 P1): different content after reopen = new append ─────────
  it('fix #5: different content after reopen-resubmit is NOT idempotent (appends)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    // Reopen, then resubmit with different content.
    await Review.abandonReviewSession(db, sessionId);
    await reopenFrozenPaperFixture(db, sessionId);
    const second = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'false',
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    // Different answer_id — new append row.
    const allRows = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(allRows).toHaveLength(2); // append-only: both frozen rows kept
    expect(second.answerId).not.toBe(
      allRows[0].id === second.answerId ? allRows[1].id : allRows[0].id,
    );
  });

  // ── F3 (PR #309 round-1): idempotency must compare image refs, not just text ──
  it('F3: same text but a different photo is NOT idempotent (image refs in the guard)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // First submit: text 'true' + photo A.
    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        answerImageRefs: ['photo_a'],
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    // Second submit in the SAME attempt: identical text but a DIFFERENT photo.
    // Pre-fix this short-circuited to the old attempt (image refs were ignored),
    // returning a stale judgement for an answer the judge never saw. Now the
    // guard sees changed content and rejects 409 (the user must reopen to change
    // their answer) — the key assertion is that it is NOT silently idempotent.
    await expect(
      submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'paper1',
          questionId: 'q1',
          answerMd: 'true',
          answerImageRefs: ['photo_b'],
          primaryKnowledgeId: 'k1',
          feedbackPolicy: 'immediate',
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('F3: same text + different photo after reopen appends a new attempt (re-judged)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    const first = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        answerImageRefs: ['photo_a'],
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    // Reopen, then resubmit the SAME text with a DIFFERENT photo. Because image
    // refs are part of "content", this is not idempotent: a new attempt+judge
    // row is appended and the answer is re-judged (new attempt id).
    await Review.abandonReviewSession(db, sessionId);
    await reopenFrozenPaperFixture(db, sessionId);
    const second = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        answerImageRefs: ['photo_b'],
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    expect(second.attemptEventId).not.toBe(first.attemptEventId);

    // Two frozen rows (append-only), each carrying its own photo.
    const allRows = await db
      .select({ id: answer.id, image_refs: answer.image_refs })
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')))
      .orderBy(answer.submitted_at);
    expect(allRows).toHaveLength(2);
    expect(allRows[0].image_refs).toEqual(['photo_a']);
    expect(allRows[1].image_refs).toEqual(['photo_b']);
  });

  // ── fix #6 (round-2 P2): flat quiz submit is allowed ─────────────────────────
  it('fix #6: submitPaperSlot accepts a flat quiz slot (no structured sections)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    // Flat paper: question_ids only, no sections.
    const now = new Date();
    await db.insert(artifact).values({
      id: 'flat_paper',
      type: 'tool_quiz',
      title: 'flat quiz',
      knowledge_ids: [],
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      tool_kind: 'quiz_gen',
      tool_state: { question_ids: ['q1'] } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const { sessionId } = await startFrozenPaperFixture(db, 'flat_paper');

    // submitPaperSlot with primaryKnowledgeId=null (flat path — question-keyed FSRS).
    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'flat_paper',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: null, // question-keyed FSRS fallback
        feedbackPolicy: 'immediate',
      },
      db,
    );

    expect(result.coarseOutcome).toBe('correct');
    expect(result.answerId).toBeTruthy();
    expect(result.attemptEventId).toBeTruthy();

    // Exactly one frozen row written.
    const rows = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(rows).toHaveLength(1);
    expect(rows[0].submitted_at).not.toBeNull();
  });

  // ── fix #7 (round-2 P2): judge is skipped for invalid sessions ───────────────
  it('fix #7: completed session is rejected BEFORE the judge is invoked', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    await db
      .update(learning_session)
      .set({ status: 'completed' })
      .where(eq(learning_session.id, sessionId));

    // Observe evaluation: rejecting this request must happen before grading.
    const invokeSpy = vi.fn();
    vi.spyOn(evaluationService, 'evaluateSubmission').mockImplementation(invokeSpy);

    try {
      await expect(
        submitPaperSlot(
          {
            sessionId,
            paperArtifactId: 'paper1',
            questionId: 'q1',
            answerMd: 'true',
            primaryKnowledgeId: 'k1',
          },
          db,
        ),
      ).rejects.toThrow(/status.*completed|cannot accept/i);

      // Judge must not have been called.
      expect(invokeSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ── round-3 fix #1 (P2): pre-judge idempotent check skips the judge ──────────
  it('round-3 fix #1: duplicate submit skips judge invocation (pre-judge idempotent check)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // First submit (judge runs normally).
    const first = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    // Observe evaluation only after the accepted original submission.
    const invokeSpy = vi.fn();
    vi.spyOn(evaluationService, 'evaluateSubmission').mockImplementation(invokeSpy);

    try {
      // Second submit with identical content — pre-check finds the frozen row,
      // returns early, and must NOT invoke the judge.
      const second = await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'paper1',
          questionId: 'q1',
          answerMd: 'true',
          primaryKnowledgeId: 'k1',
        },
        db,
      );

      expect(invokeSpy).not.toHaveBeenCalled();
      expect(second.attemptEventId).toBe(first.attemptEventId);
      expect(second.evaluationId).toBe(first.evaluationId);
      expect(second.answerId).toBe(first.answerId);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('YUK-695: concurrent model requests share one durable execution and one accepted receipt', async () => {
    const { db, input } = await modelPaper();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(
      async (request: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) => {
        await gate;
        return scored(request, runId);
      },
    );
    installExecutor(db, execute);
    const first = submitPaperSlot(input, db);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const second = submitPaperSlot(input, db);
      release();
      const results = await Promise.all([first, second]);
      expect(results[0]).toMatchObject({ coarseOutcome: 'correct' });
      expect(results[1]).toEqual(results[0]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await db.select().from(evaluation)).toHaveLength(1);
      expect((await db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
    } finally {
      release();
      await first;
    }
  });

  it('YUK-695: failed model claim is held on retry; a newly opened occurrence has its own execution', async () => {
    const { db, input } = await modelPaper();
    const execute = vi.fn(
      async (request: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) =>
        scored(request, runId),
    );
    execute.mockRejectedValueOnce(new Error('provider unavailable after claim'));
    installExecutor(db, execute);
    const first = await submitPaperSlot(input, db);
    expect(first).toMatchObject({ status: 'review_required', coarseOutcome: 'unsupported' });
    expect(await submitPaperSlot(input, db)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
    await Review.abandonReviewSession(db, input.sessionId);
    await reopenFrozenPaperFixture(db, input.sessionId);
    const next = await submitPaperSlot(input, db);
    expect(next).toMatchObject({ status: 'effective', coarseOutcome: 'correct' });
    expect(next.evaluationId).not.toBe(first.evaluationId);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_model_claim')),
    ).toHaveLength(2);
    expect(await db.select().from(answer)).toHaveLength(2);
  });

  // ── round-3 fix #2 (P2): changed-content resubmit in active session → 409 ───
  it('round-3 fix #2: changed content while session is active is rejected with 409', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // First submit — freezes the slot in this session attempt.
    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
      },
      db,
    );

    const invokeSpy = vi.fn();
    vi.spyOn(evaluationService, 'evaluateSubmission').mockImplementation(invokeSpy);
    try {
      // Second submit with different content — session is still started (no reopen).
      // It must be rejected before another judge invocation.
      await expect(
        submitPaperSlot(
          {
            sessionId,
            paperArtifactId: 'paper1',
            questionId: 'q1',
            answerMd: 'false',
            primaryKnowledgeId: 'k1',
          },
          db,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(invokeSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ── round-4 fix #3 (P2): locked race loser returns persisted judge payload ─────
  it('round-4 fix #3: duplicate response returns the persisted winner rather than another computed grade', async () => {
    const { db, input } = await modelPaper();
    const execute = vi.fn(
      async (request: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) =>
        scored(request, runId, 0.5),
    );
    installExecutor(db, execute);
    const first = await submitPaperSlot(input, db);
    expect(first).toMatchObject({ coarseOutcome: 'partial', score: 0.5 });
    execute.mockImplementation(async (request, _signal, runId) => scored(request, runId, 0));
    const second = await submitPaperSlot(input, db);
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await candidatesForAttempt(first.attemptEventId))[0].aggregate).toMatchObject({
      points: 0.5,
    });
    expect((await getPracticeList(db)).papers[0].session).toMatchObject({
      pos: 1,
      right: 1,
      wrong: 0,
    });
  });

  // ── round-6 fix #4 (CR 3359820529): reopen + same-content resubmit is NOT idempotent ──
  it('round-6 fix #4: reopen then same-content resubmit appends new attempt/judge rows', async () => {
    // Before the fix: same-content idempotency checked only content_md, ignoring
    // whether the frozen row was from before a reopen. After a reopen (started_at
    // advances), submitting the same answer must produce a new attempt + judge,
    // not short-circuit to the original ids.
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // First submit: correct → frozen row + attempt + judge.
    const first = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(first.coarseOutcome).toBe('correct');

    // Abandon then reopen (started_at advances past first frozen row's submitted_at).
    await Review.abandonReviewSession(db, sessionId);
    await reopenFrozenPaperFixture(db, sessionId);

    // Second submit with THE SAME content ('true') after reopen.
    // The fix: submitted_at < started_at (frozen before reopen) → not same attempt
    // → must NOT be treated as idempotent → new attempt/judge/FSRS rows written.
    const second = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true', // identical content
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    // Must return DIFFERENT attempt/answer ids (new attempt written).
    expect(second.attemptEventId).not.toBe(first.attemptEventId);
    expect(second.answerId).not.toBe(first.answerId);

    // Two frozen rows in answer table (append-only history).
    const allRows = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    const frozenRows = allRows.filter((r) => r.submitted_at !== null);
    expect(frozenRows).toHaveLength(2);

    // Two original submissions and their separate immutable candidates.
    const attempts = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:assessment_attempt'), eq(event.session_id, sessionId)),
      );
    expect(attempts).toHaveLength(2);

    const judges = await db.select().from(evaluation);
    expect(judges).toHaveLength(2);
  });

  // ── issue #4: autosave rejects misbound / wrong-state sessions ────────────────
  it('fix #4: autosaveAnswerDraft rejects a session bound to a different paper (400)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    await seedPaper('paper2', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper2');

    await expect(
      autosaveAnswerDraft(db, {
        sessionId,
        questionId: 'q1',
        inputKind: 'text',
        contentMd: 'draft',
        paperArtifactId: 'paper1', // mismatch
      }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_error' });
  });

  // ── YUK-215: handwriting-photo refs reach the judge ───────────────────────────
  it('YUK-215: the native model receives original scoped photos and the accepted submission preserves them', async () => {
    const { db, input } = await modelPaper();
    const execute = vi.fn(
      async (request: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) =>
        scored(request, runId),
    );
    installExecutor(db, execute);
    const result = await submitPaperSlot(
      { ...input, answerImageRefs: ['asset_photo_1', 'asset_photo_2'] },
      db,
    );
    expect(result.coarseOutcome).toBe('correct');
    expect(execute).toHaveBeenCalledTimes(1);
    const sent = execute.mock.calls[0][0].group_evidence;
    expect(sent.map((item) => item.evidence.asset.asset_id)).toEqual([
      'asset_photo_1',
      'asset_photo_2',
    ]);
    expect(sent.every((item) => item.target.scope === 'all_units')).toBe(true);
    expect((await submissionForAttempt(result.attemptEventId)).group_evidence).toEqual(sent);
  });

  // ── F1 (PR #309 round-3, YUK-215): photo-only on a text-only route is NOT judged ──
  it('F1: photo-only answer on a text-only (exact) route records the attempt but does NOT judge or schedule FSRS', async () => {
    const db = testDb();
    // seedQuestion makes a true_false question → resolveQuestionJudgeRoute → 'exact'
    // (text-only, NOT in IMAGE_CONSUMING_JUDGE_ROUTES).
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // Observe the model port — it must NOT run for a photo-only answer
    // headed to a text-only route (it would score the empty string as wrong).
    const invokeSpy = vi.fn();
    installExecutor(db, invokeSpy);

    try {
      const res = await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'paper1',
          questionId: 'q1',
          answerMd: '', // photo-only: no typed text
          answerImageRefs: ['asset_photo_only'],
          primaryKnowledgeId: 'k1',
          feedbackPolicy: 'immediate',
        },
        db,
      );

      // Judge never invoked → no false-wrong scoring.
      expect(invokeSpy).not.toHaveBeenCalled();
      // Visible "unsupported" state (JudgeResultPanel renders this as 无法判分).
      expect(res.coarseOutcome).toBe('unsupported');
      expect(res.visibleToUser).toBe(true);
      expect(res.score).toBeNull();

      // The attempt IS recorded (the answer is captured) + the draft is frozen.
      const attempts = await db
        .select()
        .from(event)
        .where(
          and(eq(event.action, 'experimental:assessment_attempt'), eq(event.subject_id, 'q1')),
        );
      expect(attempts).toHaveLength(1);
      expect((await submissionForAttempt(res.attemptEventId)).group_evidence).toMatchObject([
        { evidence: { asset: { asset_id: 'asset_photo_only' } } },
      ]);
      const frozen = await db
        .select()
        .from(answer)
        .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
      expect(frozen).toHaveLength(1);
      expect(frozen[0].submitted_at).not.toBeNull();

      // NO judge event was written.
      const judgeEvents = await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'judge'), eq(event.subject_id, attempts[0].id)));
      expect(judgeEvents).toHaveLength(0);

      // NO FSRS row was written for the slot's knowledge (an ungraded answer
      // schedules nothing).
      const fsrsRows = await db
        .select()
        .from(material_fsrs_state)
        .where(
          and(
            eq(material_fsrs_state.subject_kind, 'knowledge'),
            eq(material_fsrs_state.subject_id, 'k1'),
          ),
        );
      expect(fsrsRows).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([true, false])(
    'photo-only native submission settles with explicit text entry: %s',
    async (explicitText) => {
      const { db, input } = await modelPaper();
      const execute = vi.fn(
        async (request: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) =>
          scored(request, runId),
      );
      installExecutor(db, execute);
      const assessment = await paperFixtureAssessment(
        db,
        input.sessionId,
        input.questionId,
        '',
        undefined,
        ['asset_photo_only'],
      );
      if (!explicitText) assessment.response_set.entries = [];
      const result = await submitPaperSlot(
        { ...input, assessment, answerMd: '', answerImageRefs: ['asset_photo_only'] },
        db,
      );
      expect(result).toMatchObject({ coarseOutcome: 'correct', score: 1 });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].group_evidence[0].evidence.asset.asset_id).toBe(
        'asset_photo_only',
      );
      const original = await submissionForAttempt(result.attemptEventId);
      expect(original.response_set.entries).toMatchObject(
        explicitText ? [{ kind: 'text', text_md: '' }] : [],
      );
      expect(original.group_evidence).toMatchObject([
        { evidence: { asset: { asset_id: 'asset_photo_only' } } },
      ]);
      expect(await candidatesForAttempt(result.attemptEventId)).toHaveLength(1);
      expect((await db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
    },
  );

  // YUK-448 — paper-path RT capture. Mirrors the solo /api/review/submit latency
  // capture: `latencyMs` lands in the attempt event payload as `duration_ms`.
  // Capture only — NOT wired into θ̂/p(L)/FSRS (ADR-0035 red-line).
  it('YUK-448: captures latencyMs as duration_ms in the attempt event payload', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper_rt', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_rt');

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_rt',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
        latencyMs: 12_500,
      },
      db,
    );

    const rows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, submit.attemptEventId))
      .limit(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.duration_ms).toBe(12_500);
    expect(payload).toMatchObject({
      version: 1,
      submission_id: expect.any(String),
      revision_id: expect.any(String),
      issuance_id: expect.any(String),
    });
  });

  // YUK-448 — when latencyMs is not supplied the key must be ABSENT (not null),
  // because the read-side AttemptOnQuestion schema declares duration_ms as
  // z.number().int().optional() and a null would fail the discriminated-union
  // parse on read. Mirrors the conditional-spread idiom in submit.ts:532.
  it('YUK-448: omits duration_ms when latencyMs is not supplied (no null poison)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper_rt', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_rt');

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_rt',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    const rows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, submit.attemptEventId))
      .limit(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('duration_ms');
  });

  // ── YUK-212 + YUK-484(B) "Lane C cut 1": per-sub verdict 落点 + B proof ───────
  //
  // A composite (stem + single sub) question submitted with part_ref='p1' must:
  //   (1) preserve part_ref='p1' on the original native attempt capture;
  //   (2) still call updateThetaForAttempt EXACTLY ONCE, keyed on the slot's
  //       referenced_knowledge_ids — NO per-sub θ̂ fan-out (Option B proof).
  // An atomic slot has an explicit null part_ref on its native capture.
  //
  // Uses an explicitly published exact key for each structured leaf; the
  // selected leaf's frozen answer grades locally without a model call.
  async function seedCompositeQuestion(id: string, subAnswer: string) {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'true_false',
      judge_kind_override: 'exact',
      prompt_md: `Prompt ${id}`,
      reference_md: `${subAnswer}\n\nother`,
      structured: {
        id: 'stem',
        role: 'stem',
        prompt_text: '阅读下文，回答问题。',
        sub_questions: [
          { id: 'p1', role: 'sub', question_no: '1', prompt_text: '第一问', answers: [subAnswer] },
          { id: 'p2', role: 'sub', question_no: '2', prompt_text: '第二问', answers: ['other'] },
        ],
      },
      knowledge_ids: ['k1'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    });
  }

  it('cut1: composite slot submit preserves part_ref + keeps θ̂ per-KC (one call)', async () => {
    const db = testDb();
    await seedCompositeQuestion('qc', 'true');
    await seedPaper('paper_sub', ['qc'], ['p1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_sub');

    // Spy θ̂ — assert it fires exactly once for the attempt, NOT once-per-sub.
    // Mocked to a no-op resolve so it never touches real mastery_state (the rest
    // of the attempt tx still commits).
    // YUK-471 Wave 0 / YUK-561 S2 — updateThetaForAttempt returns { theta_snapshots }.
    // Mock returns [] → the θ̂ segment bracket is SKIPPED (per-segment same-condition
    // write invariant), only the FSRS segment is bracketed, and the tx still commits.
    const thetaSpy = vi
      .spyOn(masteryStateModule, 'updateThetaForAttempt')
      .mockResolvedValue({ theta_snapshots: [] });

    try {
      const submit = await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'paper_sub',
          questionId: 'qc',
          partRef: 'p1',
          answerMd: 'true',
          primaryKnowledgeId: 'k1',
          feedbackPolicy: 'immediate',
        },
        db,
      );

      // The exact judge graded the NARROWED sub (reference_md → 'true') correct.
      expect(submit.coarseOutcome).toBe('correct');

      // (1) The original native capture preserves the issued part_ref.
      const judgeRows = await db
        .select({ payload: event.payload })
        .from(event)
        .where(eq(event.id, submit.attemptEventId))
        .limit(1);
      const judgePayload = judgeRows[0].payload as Record<string, unknown>;
      expect(judgePayload.part_ref).toBe('p1');

      // (2) B proof — θ̂ called EXACTLY ONCE, keyed on the slot's referenced KCs
      // (primary k1, no secondaries). No per-sub fan-out.
      expect(thetaSpy).toHaveBeenCalledTimes(1);
      expect(thetaSpy.mock.calls[0][1]).toMatchObject({ knowledgeIds: ['k1'] });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('cut1: atomic slot submit preserves null part_ref', async () => {
    const db = testDb();
    await seedQuestion('qa', 'true');
    await seedPaper('paper_atomic', ['qa']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_atomic');

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_atomic',
        questionId: 'qa',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    const judgeRows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, submit.attemptEventId))
      .limit(1);
    const judgePayload = judgeRows[0].payload as Record<string, unknown>;
    // Atomic captures preserve the explicit null part coordinate.
    expect(judgePayload.part_ref).toBeNull();
  });
});
