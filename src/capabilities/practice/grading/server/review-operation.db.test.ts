import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCopilotConversation } from '@/capabilities/copilot/server/conversation-lifecycle';
import { previewReviewAdvice } from '@/capabilities/practice/scheduling/public';
import { serializeBlockFence } from '@/core/schema/blocks';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import { NativeJudgePendingSubmitInput } from '@/core/schema/event/judge-pending-events';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import { blockDigest, blockRefForDigest } from '@/kernel/blocks/digest';
import { writeEvent } from '@/kernel/events';
import { readQuestionCard } from '@/kernel/read-models/question-card';
import { STUDY_ASSISTANCE_ACTION } from '@/kernel/records/study-reference';
import {
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { CreateAttemptBodySchema } from '../../api/contracts';
import { createAttempt } from '../api/submit';
import { runJudgeRun } from '../jobs/judge_run';
import {
  getIssuanceState,
  requestAssessmentIssuance,
  requestResponseDraftSave,
  requestReviewAnswer,
} from '../public';
import { dispatchNativeAttempt, executeNativeAttempt } from './assessment/durable-attempt';
import * as evaluationService from './judge/evaluate-submission';
import { createRecordedModelExecutor } from './judge/recorded-model-executor';
import { fenceJudgeUnitClaim } from './judge-operational';
import { submitReviewAnswer } from './review-operation';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function effects() {
  const db = testDb();
  return {
    mastery: await db.select().from(mastery_state).orderBy(mastery_state.subject_id),
    fsrs: await db.select().from(material_fsrs_state).orderBy(material_fsrs_state.subject_id),
    head: await db.select().from(evaluation_effective_head),
    events: await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_activation')),
  };
}

async function pendingModel() {
  const db = testDb();
  const f = await nativeSoloHttpFixture(db, { model: true });
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(
    (database, _signal, _admission, execution) =>
      createRecordedModelExecutor(
        database,
        f.execute,
        execution ? { fence: (tx, request) => fenceJudgeUnitClaim(tx, execution, request) } : {},
      ),
  );
  const jobSchema = z.object({
    run_id: z.string(),
    caller: z.literal('native_assessment'),
    submit: NativeJudgePendingSubmitInput,
    operational: JudgeWorkflowInput,
  });
  const jobs: z.infer<typeof jobSchema>[] = [];
  const send = vi.fn(async (_queue: string, data: unknown, options?: { id?: string }) => {
    jobs.push(jobSchema.parse(data));
    return options?.id ?? null;
  });
  const body = CreateAttemptBodySchema.parse(f.body());
  const result = await submitReviewAnswer(db, body, {
    durableEnabled: true,
    dispatchNativeAttempt: (database, questionId, original, options) =>
      dispatchNativeAttempt(database, questionId, original, options, {
        checkRateLimit: () => 1,
        boss: { send },
      }),
  });
  if (result.kind !== 'pending') throw new Error('expected pending original');
  const job = jobs.find((queued) => queued.run_id === result.run_id);
  if (!job) throw new Error('expected mapped native delivery');
  return {
    ...f,
    body,
    result,
    send,
    job,
  };
}

describe('request independent review operation on business tables', () => {
  // @invariant concurrency: direct submit, HTTP entry and worker replay all resolve to the same pending original — background settlement commits once and redelivery skips as already_persisted
  // @fails-if mint a second submission for the replay or let redelivery re-execute the model; the result-equality, skipped/already_persisted, execute-count-1 and single-submission assertions fail
  it('keeps pending originals and background replays on the same final commit chain', async () => {
    const f = await pendingModel();
    expect(f.execute).not.toHaveBeenCalled();
    expect((await effects()).fsrs).toHaveLength(0);
    const http = await createAttempt(nativeHttpRequest(f.body));
    expect(http.status).toBe(202);
    expect(await http.json()).toMatchObject({ verdict: 'pending', run_id: f.result.run_id });
    expect(await submitReviewAnswer(testDb(), f.body)).toEqual(f.result);
    expect(f.send).toHaveBeenCalledTimes(1);
    const first = await executeNativeAttempt(testDb(), f.job);
    expect(first.status).toBe('effective');
    const before = await effects();
    expect(before.fsrs).toHaveLength(1);
    expect(
      await runJudgeRun(testDb(), f.job, {
        retryCount: 1,
        retryLimit: 2,
        deliveryId: f.job.operational.delivery_id,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'already_persisted' });
    expect(await effects()).toEqual(before);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });
});

async function countEvents(action: string): Promise<number> {
  const rows = await testDb().select({ id: event.id }).from(event).where(eq(event.action, action));
  return rows.length;
}

describe('review advice answer lifecycle', () => {
  // @invariant grading: automatic advice commits one accepted original and freezes the learner's duration and confidence into both the attempt and settlement replay inputs
  // @fails-if preview and commit create separate submissions, the nested committed response drops the rating claim, or settlement reads different capture values from the attempt
  it('commits one automatic advice original with frozen learner capture', async () => {
    const db = testDb();
    const f = await nativeSoloHttpFixture(db);
    const result = await previewReviewAdvice(
      db,
      {
        question_id: f.id,
        assessment: f.assessment,
        response_md: 'A',
        answer_image_refs: [],
        accept_pending: true,
        commit: {
          session_id: 'review-advice-session',
          reasoning_trace: 'controlled variables',
          self_confidence: 4,
          latency_ms: 1234,
          referenced_knowledge_ids: f.knowledgeIds,
        },
      },
      new AbortController().signal,
    );
    if ('verdict' in result || !result.committed)
      throw new Error('automatic advice stayed uncommitted');

    expect(result.automatic_commit).toBe(true);
    expect(result.committed).toMatchObject({
      status: 'effective',
      evidence: { self_claim: { rating: null, confidence: 4 } },
      judge: { auto_rated: true },
    });
    expect(await db.select().from(assessment_submission)).toHaveLength(1);
    expect(await countEvents('experimental:assessment_attempt')).toBe(1);
    expect(await countEvents('experimental:assessment_settlement')).toBe(1);

    const [attempt] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(attempt?.payload).toMatchObject({
      response_md: 'A',
      reasoning_trace: 'controlled variables',
      self_confidence: 4,
      duration_ms: 1234,
    });
    const [settlement] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(settlement?.payload.replay_inputs).toMatchObject({
      theta: { responseTimeMs: 1234 },
      forgettingInput: {
        fact: { self_confidence: 4, latency_ms: 1234, confidence: 'high' },
      },
    });
  });
});

describe('conversation question card confirmation', () => {
  // @invariant grading: a chat-card answer stays a recoverable submission plus one assisted candidate until the learner confirms, and repeated identical confirmation converges on one attempt, one activation and one schedule
  // @fails-if preview writes an attempt/activation/settlement, the second confirmation advances the head or writes another attempt/activation/settlement, or the final card/attempt loses the conversation binding or its unknown-help snapshot
  it('defers settlement until confirmation and settles one attempt across repeated confirmation', async () => {
    const db = testDb();
    const subjectRoot = 'seed:math:root';
    const f = await nativeSoloHttpFixture(db, { knowledgeIds: [subjectRoot] });
    const { sessionId } = await createCopilotConversation(db);
    const cardBlock = {
      v: 1 as const,
      kind: 'question_ref' as const,
      display: 'inline' as const,
      question_ids: [f.id],
      alt: '题目',
      label: '打开题目',
    };
    const blockRef = blockRefForDigest(blockDigest(cardBlock));
    const replyId = `reply_${sessionId}`;
    await writeEvent(db, {
      id: replyId,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: replyId,
      outcome: null,
      payload: {
        surface: 'copilot',
        session_id: sessionId,
        reply_md: `试试这张卡：\n\n${serializeBlockFence(cardBlock)}`,
      },
    });

    const issue = () =>
      requestAssessmentIssuance(db, async () => ({
        group_id: f.id,
        chat_card: { session_id: sessionId, block_ref: blockRef },
      }));
    const firstIssue = await issue();
    const retriedIssue = await issue();
    expect(firstIssue).toMatchObject({ status: 'issued' });
    expect(retriedIssue).toMatchObject({ status: 'replayed' });
    expect(retriedIssue.issuance.issuance_id).toBe(firstIssue.issuance.issuance_id);
    const issuanceId = firstIssue.issuance.issuance_id;
    const [issuanceRow] = await db
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, issuanceId));
    expect(issuanceRow?.container_occurrence_ref).toBe(`copilot-card:${sessionId}:${blockRef}`);
    const assistance = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, STUDY_ASSISTANCE_ACTION),
          eq(event.subject_kind, 'issuance'),
          eq(event.subject_id, issuanceId),
        ),
      );
    expect(assistance).toHaveLength(1);
    expect(assistance[0]?.payload).toMatchObject({ kind: 'chat_context', impact: 'unknown' });

    const baseline = await effects();
    const coordinates = {
      issuance_id: issuanceId,
      evaluation_group_id: `eg_chat_card_${f.id}`,
      idempotency_key: `chat_card_${f.id}`,
      response_set: f.assessment.response_set,
      group_evidence: [],
    };
    const adviceBody = (extra: Record<string, unknown> = {}) => ({
      question_id: f.id,
      response_md: '',
      assessment: coordinates,
      ...extra,
    });

    await requestResponseDraftSave(db, issuanceId, async () => ({
      response_set: coordinates.response_set,
      group_evidence: [],
    }));
    const preview = await previewReviewAdvice(
      db,
      adviceBody({ commit: { session_id: sessionId }, accept_pending: true }),
      new AbortController().signal,
    );
    if ('verdict' in preview) throw new Error('advice preview diverted to durable judging');
    expect(preview.automatic_commit).toBe(false);
    expect(preview).not.toHaveProperty('committed');
    expect(preview.judge.suggested_rating).not.toBeNull();
    expect(preview.activation_intent.evaluation_id).toBe(preview.candidate_id);

    const afterPreview = await effects();
    expect(afterPreview.mastery).toEqual(baseline.mastery);
    expect(afterPreview.fsrs).toEqual(baseline.fsrs);
    expect(afterPreview.events).toEqual(baseline.events);
    expect(
      afterPreview.head.every(
        (row) => row.effective_evaluation_id === null && row.generation === 0,
      ),
    ).toBe(true);
    expect(await countEvents('experimental:assessment_attempt')).toBe(0);
    expect(await countEvents('experimental:assessment_settlement')).toBe(0);
    const [candidate] = await db
      .select()
      .from(evaluation)
      .where(eq(evaluation.submission_id, preview.submission_id));
    expect(candidate?.status).toBe('completed');
    expect(candidate?.provenance?.assisted).toBe(true);
    expect(await db.select().from(assessment_submission)).toHaveLength(1);

    const recovered = await getIssuanceState(db, issuanceId);
    expect(recovered.submissions).toHaveLength(1);
    expect(recovered.submissions[0]?.response_set).toEqual(coordinates.response_set);
    expect((await readQuestionCard(db, f.id, sessionId)).latest_attempt).toMatchObject({
      issuance_id: issuanceId,
      status: 'graded_unconfirmed',
    });
    expect((await readQuestionCard(db, f.id)).latest_attempt).toBeNull();

    const restored = await previewReviewAdvice(db, adviceBody(), new AbortController().signal);
    if ('verdict' in restored) throw new Error('advice restore diverted to durable judging');
    expect(restored.candidate_id).toBe(preview.candidate_id);
    expect(restored.judge.suggested_rating).toBe(preview.judge.suggested_rating);
    expect(restored.activation_intent).toEqual(preview.activation_intent);
    expect(await db.select().from(evaluation)).toHaveLength(1);
    expect(await countEvents('experimental:assessment_attempt')).toBe(0);

    const confirm = (rating: 'again' | 'hard' | 'good' | 'easy') =>
      requestReviewAnswer(
        db,
        async () => ({
          question_id: f.id,
          session_id: sessionId,
          rating,
          auto_rate: false,
          assessment: coordinates,
          activation_intent: restored.activation_intent,
          response_md: '',
        }),
        { durableEnabled: false },
      );
    const rating = preview.judge.suggested_rating;
    if (rating === null) throw new Error('deterministic fixture did not recommend a rating');
    const firstConfirm = await confirm(rating);
    if (firstConfirm.kind !== 'committed') throw new Error('confirmation stayed pending');
    expect(firstConfirm.body.status).toBe('effective');
    expect(firstConfirm.body.assessment.effect).toBe('applied');
    expect(firstConfirm.body.assessment.candidate_id).toBe(preview.candidate_id);

    const afterFirst = await effects();
    expect(afterFirst.events).toHaveLength(1);
    expect(afterFirst.events[0]?.payload).toMatchObject({ generation: 1, user_rating: rating });
    expect(afterFirst.mastery).toHaveLength(0);
    expect(afterFirst.fsrs).toMatchObject([{ subject_kind: 'question', subject_id: f.id }]);
    expect(await countEvents('experimental:assessment_attempt')).toBe(1);
    expect(await countEvents('experimental:assessment_settlement')).toBe(1);

    const attempts = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.payload).toMatchObject({
      submission_id: preview.submission_id,
      source: { kind: 'conversation', session_id: sessionId, block_ref: blockRef },
    });
    expect(attempts[0]?.payload).not.toHaveProperty('stream_item_id');
    const [submissionReceipt] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_submission'),
          eq(event.subject_kind, 'submission'),
          eq(event.subject_id, preview.submission_id),
        ),
      );
    expect(submissionReceipt?.payload.assistance).toMatchObject({ status: 'unknown' });
    expect(
      (submissionReceipt?.payload.assistance as { event_ids?: string[] } | undefined)?.event_ids,
    ).toContain(assistance[0]?.id);

    const secondConfirm = await confirm(rating);
    if (secondConfirm.kind !== 'committed') throw new Error('repeat confirmation stayed pending');
    expect(secondConfirm.body.review_event.id).toBe(firstConfirm.body.review_event.id);
    expect(secondConfirm.body.assessment.effect).toBe('idempotent_replay');
    expect(await effects()).toEqual(afterFirst);
    expect(await countEvents('experimental:assessment_attempt')).toBe(1);
    expect(await countEvents('experimental:assessment_settlement')).toBe(1);
    expect(await countEvents('experimental:assessment_activation')).toBe(1);
    expect((await readQuestionCard(db, f.id, sessionId)).latest_attempt).toMatchObject({
      issuance_id: issuanceId,
      status: 'submitted',
    });
    const finalState = await getIssuanceState(db, issuanceId);
    expect(finalState.submissions).toHaveLength(1);
    expect(finalState.settled).toMatchObject({ kind: 'terminal' });
  });
});
