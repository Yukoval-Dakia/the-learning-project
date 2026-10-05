import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  artifact,
  assessment_issuance,
  evaluation,
  evaluation_effective_head,
  event,
  learning_session,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { getQuestionTimeline } from '@/kernel/read-models/question-activity';
import { seedFrozenSolveQuestion } from '../../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createAnswerDraft } from '../api/paper-answer-route';
import { createPaperReviewSession } from '../api/paper-session-create';
import { createPaperSubmission } from '../api/paper-submit-route';
import { PATCH as transitionReview } from '../api/review-session-detail';
import { previewFormalAttempt } from './assessment/attempt';
import { submitNativePaperAttempt } from './assessment/paper-attempt';
import { readPaperAssessmentBinding } from './assessment/paper-issuance';
import { getIssuanceState } from './assessment/submit';
import { activateSubmissionCandidate, evaluateSubmission } from './judge/evaluate-submission';
import { getPaperDetail } from './paper-detail';
import { getPracticeList } from './practice-read';

async function paper(questionIds: string[]) {
  const id = createId();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'tool_quiz',
      title: '独立评分试卷',
      knowledge_ids: [],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: questionIds,
        sections: questionIds.map((qid, i) => ({
          knowledge_focus: [],
          feedback_policy: i ? 'immediate' : 'judge_now_show_later',
          adaptation_policy: 'none',
          assignments: [
            {
              question_id: qid,
              primary_knowledge_id: '',
              secondary_knowledge_ids: [],
              selection_reason: '复习两个独立能力，不构造联判组',
              review_profile_snapshot: {},
            },
          ],
        })),
      },
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
  return id;
}

beforeEach(resetDb);
describe('paper opening freezes actual assessment occurrences', () => {
  it('issues every independent slot once, pins feedback and preserves originals after editing', async () => {
    const db = testDb();
    const a = await seedFrozenSolveQuestion(db),
      b = await seedFrozenSolveQuestion(db);
    const paperId = await paper([a.id, b.id]);
    const [first, second] = await Promise.all([
      createPaperReviewSession(paperId),
      createPaperReviewSession(paperId),
    ]);
    expect(first.sessionId).toBe(second.sessionId);
    const binding = await readPaperAssessmentBinding(db, first.sessionId);
    expect(binding).not.toBeNull();
    if (!binding) throw new Error('expected frozen paper binding');
    expect(binding.slots).toHaveLength(2);
    expect(new Set(binding?.slots.map((s) => s.evaluation_group_id)).size).toBe(2);
    expect(binding?.slots.map((s) => s.feedback_policy)).toEqual([
      'judge_now_show_later',
      'immediate',
    ]);
    await db
      .update(question)
      .set({ prompt_md: '已更改题面', reference_md: '新的答案' })
      .where(eq(question.id, a.id));
    await db
      .update(artifact)
      .set({ tool_state: { question_ids: [b.id] } })
      .where(eq(artifact.id, paperId));
    const replay = await createPaperReviewSession(paperId);
    expect(await readPaperAssessmentBinding(db, replay.sessionId)).toEqual(binding);
    const detail = await getPaperDetail(db, paperId);
    expect(detail?.sections.flatMap((section) => section.slots)).toHaveLength(2);
    expect((await getPracticeList(db)).papers[0].total_slots).toBe(2);
    expect(detail?.sections[0].slots[0].assessment?.practice_dto.faces[0].prompt_md).toContain(
      'a≠b',
    );
    expect(JSON.stringify(detail)).not.toContain('新的答案');
    const state = await getIssuanceState(db, binding.slots[0].issuance_id);
    expect(state.practice_dto?.faces[0].prompt_md).toContain('a≠b');
    expect(JSON.stringify(state.practice_dto)).not.toContain('解析');
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_paper_issued')),
    ).toHaveLength(1);
  });

  it('rolls the entire new session and its partial issuance back when a slot is unpublished', async () => {
    const db = testDb();
    const a = await seedFrozenSolveQuestion(db);
    const missing = createId();
    await db.insert(question).values({
      id: missing,
      kind: 'derivation',
      prompt_md: '尚未发布题',
      reference_md: '未核验',
      knowledge_ids: [],
      difficulty: 2,
      source: 'manual',
      version: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const before = await db.select().from(assessment_issuance);
    const paperId = await paper([a.id, missing]);
    await expect(createPaperReviewSession(paperId)).rejects.toMatchObject({ code: 'unpublished' });
    expect(await db.select().from(learning_session)).toHaveLength(0);
    expect(await db.select().from(assessment_issuance)).toHaveLength(before.length);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_paper_issued')),
    ).toHaveLength(0);
  });
  it('submits frozen independent slots and buffers all public grading feedback until completion', async () => {
    const db = testDb();
    const a = await seedFrozenSolveQuestion(db),
      b = await seedFrozenSolveQuestion(db);
    const paperId = await paper([a.id, b.id]);
    const { sessionId } = await createPaperReviewSession(paperId);
    const binding = await readPaperAssessmentBinding(db, sessionId);
    if (!binding) throw new Error('binding absent');
    const assessment = { ...binding.slots[0], response_set: a.responseSet('a-b') };
    const request = () =>
      new Request('http://localhost/api/paper/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          question_id: a.id,
          answer_md: 'a-b',
          assessment,
        }),
      });
    await db
      .update(question)
      .set({ reference_md: 'a-b', prompt_md: '改变后的题面' })
      .where(eq(question.id, a.id));
    const res = await createPaperSubmission(request(), { id: paperId });
    expect(res.status).toBe(200);
    const hidden = await res.json();
    expect(hidden.visible_to_user).toBe(false);
    expect(hidden).not.toHaveProperty('coarse_outcome');
    expect(hidden).not.toHaveProperty('score');
    expect(hidden).not.toHaveProperty('status');
    const hiddenDetail = await getPaperDetail(db, paperId);
    expect(hiddenDetail?.session).toMatchObject({ pos: 1, right: 0, wrong: 0 });
    expect((await getPracticeList(db)).papers[0].session).toMatchObject({
      pos: 1,
      right: 0,
      wrong: 0,
    });
    expect(hiddenDetail?.sections[0].slots[0].slot_state.submission).toMatchObject({
      visible_to_user: false,
    });
    expect(hiddenDetail?.sections[0].slots[0].slot_state.submission).not.toHaveProperty(
      'reference_md',
    );
    expect(await getQuestionTimeline(db, a.id)).toMatchObject([{ outcome: 'pending' }]);
    await expect(
      previewFormalAttempt(db, 'advice_preview', a.id, assessment),
    ).rejects.toMatchObject({ code: 'paper_entry_required' });
    expect((await createPaperSubmission(request(), { id: paperId })).status).toBe(200);
    expect((await db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
    await expect(
      submitNativePaperAttempt(db, {
        sessionId,
        paperArtifactId: paperId,
        questionId: a.id,
        assessment: { ...assessment, response_set: a.responseSet('a+b') },
        answerMd: 'a+b',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const second = await submitNativePaperAttempt(db, {
      sessionId,
      paperArtifactId: paperId,
      questionId: b.id,
      assessment: { ...binding.slots[1], response_set: b.responseSet('a+b') },
      answerMd: 'a+b',
    });
    expect(second.coarseOutcome).toBe('correct');
    expect(second.visibleToUser).toBe(true);
    expect(await db.select().from(material_fsrs_state)).toHaveLength(2);
    await db
      .update(learning_session)
      .set({ status: 'completed' })
      .where(eq(learning_session.id, sessionId));
    expect(await getQuestionTimeline(db, a.id)).toMatchObject([{ outcome: 'failure' }]);
    const releasedDetail = await getPaperDetail(db, paperId);
    expect(releasedDetail?.session).toMatchObject({ pos: 2, right: 1, wrong: 1 });
    expect((await getPracticeList(db)).papers[0].session).toMatchObject({
      pos: 2,
      right: 1,
      wrong: 1,
    });
    expect(releasedDetail?.sections[0].slots[0].slot_state.submission).toMatchObject({
      visible_to_user: true,
      outcome: 'incorrect',
      score: 0,
      reference_md: expect.stringContaining('a≠b'),
    });
    const released = await createPaperSubmission(request(), { id: paperId });
    expect(await released.json()).toMatchObject({
      visible_to_user: true,
      coarse_outcome: 'incorrect',
      score: 0,
    });
  });

  it('replays the current corrected grade without reactivating the original or rescheduling', async () => {
    const db = testDb();
    const q = await seedFrozenSolveQuestion(db);
    const paperId = await paper([q.id]);
    const { sessionId } = await createPaperReviewSession(paperId);
    const binding = await readPaperAssessmentBinding(db, sessionId);
    if (!binding) throw new Error('binding absent');
    const input = {
      sessionId,
      paperArtifactId: paperId,
      questionId: q.id,
      assessment: { ...binding.slots[0], response_set: q.responseSet('a-b') },
      answerMd: 'a-b',
    };
    const original = await submitNativePaperAttempt(db, input);
    expect(original.coarseOutcome).toBe('incorrect');
    if (!original.evaluationId) throw new Error('original candidate missing');
    const [row] = await db
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, original.evaluationId));
    const corrected = await evaluateSubmission(db, {
      submission_id: row.submission_id,
      evaluation_group_id: row.evaluation_group_id,
      evaluation_key: 'paper-manual-correction',
      mode: 'manual_assert',
      provenance: { source: 'manual', assisted: false },
      asserted_unit_results: row.unit_results.map((unit) => ({
        status: 'scored' as const,
        scoring_unit_id: unit.scoring_unit_id,
        points_awarded: 1,
        scored_because: 'response' as const,
        evidence_citations: [],
      })),
    });
    const [head] = await db
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, row.evaluation_group_id));
    expect(
      await activateSubmissionCandidate(
        db,
        {
          evaluation_id: corrected.record.evaluation_id,
          expected_effective_id: head.effective_evaluation_id,
          expected_generation: head.generation,
        },
        { actorRef: 'test:teacher' },
      ),
    ).toMatchObject({ status: 'activated' });
    await db
      .update(learning_session)
      .set({ status: 'completed' })
      .where(eq(learning_session.id, sessionId));
    const beforeFsrs = await db.select().from(material_fsrs_state);
    const beforeHead = await db.select().from(evaluation_effective_head);
    const replay = await createPaperSubmission(
      new Request('http://localhost/paper-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          question_id: q.id,
          answer_md: input.answerMd,
          assessment: input.assessment,
        }),
      }),
      { id: paperId },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      visible_to_user: true,
      coarse_outcome: 'correct',
      score: 1,
      evaluation_id: corrected.record.evaluation_id,
    });
    expect(await db.select().from(evaluation_effective_head)).toEqual(beforeHead);
    expect(await db.select().from(material_fsrs_state)).toEqual(beforeFsrs);
    expect(beforeFsrs[0].state.reps).toBe(1);
    await expect(
      submitNativePaperAttempt(db, {
        ...input,
        assessment: { ...input.assessment, response_set: q.responseSet('a+b') },
        answerMd: 'a+b',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('stores canonical paper drafts atomically, rejects stale saves and never resurrects submitted drafts', async () => {
    const db = testDb(),
      q = await seedFrozenSolveQuestion(testDb());
    const paperId = await paper([q.id]);
    const { sessionId } = await createPaperReviewSession(paperId);
    const binding = await readPaperAssessmentBinding(db, sessionId);
    if (!binding) throw new Error('binding absent');
    const assessment = { ...binding.slots[0], response_set: q.responseSet('a+b') };
    const save = (epoch: number, text: string) =>
      createAnswerDraft(
        new Request('http://localhost/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            question_id: q.id,
            content_md: text,
            assessment: { ...assessment, response_set: q.responseSet(text) },
            expected_save_epoch: epoch,
          }),
        }),
        { id: paperId },
      );
    const unbound = await createAnswerDraft(
      new Request('http://localhost/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          question_id: q.id,
          content_md: '旧格式不能静默丢失原生作答',
        }),
      }),
      { id: paperId },
    );
    expect(unbound.status).toBe(409);
    expect(await unbound.json()).toMatchObject({ error: 'historical_unknown' });
    const first = await save(0, 'a+b');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ save_epoch: 1 });
    expect((await save(0, '过时的答案')).status).toBe(409);
    const restored = await getPaperDetail(db, paperId);
    expect(restored?.sections[0].slots[0].assessment).toMatchObject({
      save_epoch: 1,
      response_set: q.responseSet('a+b'),
    });
    expect((await save(1, 'a+b\n\n已检查非零分母条件。')).status).toBe(200);
    await submitNativePaperAttempt(db, {
      sessionId,
      paperArtifactId: paperId,
      questionId: q.id,
      assessment,
      answerMd: 'a+b',
    });
    expect((await save(2, '迟到的草稿')).status).toBe(409);
    expect((await getIssuanceState(db, assessment.issuance_id)).draft).toBeNull();
    expect(
      (await getIssuanceState(db, assessment.issuance_id)).submissions[0].response_set,
    ).toEqual(q.responseSet('a+b'));
  });

  it('reopening creates a new occurrence atomically; pause/resume retains the original', async () => {
    const db = testDb(),
      q = await seedFrozenSolveQuestion(testDb());
    const paperId = await paper([q.id]);
    const { sessionId } = await createPaperReviewSession(paperId);
    const first = await readPaperAssessmentBinding(db, sessionId);
    const transition = (status: string) =>
      transitionReview(
        new Request('http://localhost/session', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        }),
        { id: sessionId },
      );
    expect((await transition('paused')).status).toBe(200);
    expect((await transition('started')).status).toBe(200);
    expect(await readPaperAssessmentBinding(db, sessionId)).toEqual(first);
    if (!first) throw new Error('initial binding absent');
    await submitNativePaperAttempt(db, {
      sessionId,
      paperArtifactId: paperId,
      questionId: q.id,
      assessment: { ...first.slots[0], response_set: q.responseSet('a-b') },
      answerMd: 'a-b',
    });
    expect((await transition('abandoned')).status).toBe(200);
    expect((await transition('started')).status).toBe(200);
    const second = await readPaperAssessmentBinding(db, sessionId);
    expect(second?.slots[0].issuance_id).not.toBe(first?.slots[0].issuance_id);
    expect(second?.slots[0].evaluation_group_id).not.toBe(first?.slots[0].evaluation_group_id);
    expect((await transition('started')).status).toBe(200);
    expect(await readPaperAssessmentBinding(db, sessionId)).toEqual(second);
    expect((await getPracticeList(db)).papers[0].session).toMatchObject({
      pos: 0,
      right: 0,
      wrong: 0,
    });
    const reopenedDetail = await getPaperDetail(db, paperId);
    expect(reopenedDetail?.session).toMatchObject({
      status: 'started',
      pos: 0,
      right: 0,
      wrong: 0,
    });
    expect(reopenedDetail?.sections[0].slots[0].slot_state.submission).toBeNull();
    await db
      .update(learning_session)
      .set({ status: 'completed' })
      .where(eq(learning_session.id, sessionId));
    expect(await getQuestionTimeline(db, q.id)).toMatchObject([{ outcome: 'pending' }]);
  });
});
