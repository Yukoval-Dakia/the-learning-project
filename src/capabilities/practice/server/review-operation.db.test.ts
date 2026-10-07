import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
} from '@/core/schema/intervention';
import {
  assessment_submission,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
  question,
  question_revision,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { CreateAttemptBodySchema } from '../api/contracts';
import { createAttempt } from '../api/submit';
import { submitReviewAnswerTool } from '../tools/submit-review-answer';
import { dispatchNativeAttempt, executeNativeAttempt } from './assessment/durable-attempt';
import { activateSubmissionCandidate, evaluateSubmission } from './judge/evaluate-submission';
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

async function pendingModel(failDelivery = false) {
  const db = testDb();
  const f = await nativeSoloHttpFixture(db, { model: true });
  const send = failDelivery
    ? vi.fn().mockRejectedValue(new Error('offline postcommit delivery'))
    : vi.fn().mockResolvedValue('offline-delivery');
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
  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.id, `evt_pending_${result.run_id}`));
  const accepted = JudgePendingAttemptPayload.parse(row.payload);
  if (accepted.caller !== 'native_assessment') throw new Error('expected native original');
  return {
    ...f,
    body,
    result,
    send,
    job: { run_id: result.run_id, caller: accepted.caller, submit: accepted.submit },
  };
}

describe('request independent review operation on business tables', () => {
  it('shares deterministic commit and idempotent effects with HTTP without model execution', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const body = CreateAttemptBodySchema.parse(
      f.body({
        reasoning_trace: '固定水量，改变坡度；逐次比较流速。'.repeat(80),
        self_confidence: 3,
        latency_ms: 12630,
      }),
    );
    const first = await submitReviewAnswer(testDb(), body, { durableEnabled: false });
    expect(first).toMatchObject({
      kind: 'committed',
      committed: { status: 'effective', activation: { effect: 'applied' } },
    });
    if (first.kind !== 'committed') throw new Error('expected committed original');
    const before = await effects();
    expect(before.fsrs).toHaveLength(1);
    const http = await createAttempt(nativeHttpRequest(body));
    expect(http.status).toBe(200);
    expect(await http.json()).toMatchObject({
      review_event: { id: first.committed.attempt_id },
      assessment: { submission_id: first.committed.submission.submission_id },
    });
    await submitReviewAnswer(testDb(), body, { durableEnabled: false });
    expect(await effects()).toEqual(before);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('preserves missing-original and changed-original conflicts across direct and HTTP entries', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const missing = CreateAttemptBodySchema.parse(f.body({ assessment: undefined }));
    await expect(submitReviewAnswer(testDb(), missing)).rejects.toMatchObject({
      code: 'historical_unknown',
      status: 409,
    });
    expect(await (await createAttempt(nativeHttpRequest(missing))).json()).toMatchObject({
      error: 'historical_unknown',
    });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
    await submitReviewAnswer(testDb(), CreateAttemptBodySchema.parse(f.body()));
    const before = await effects();
    const changed = CreateAttemptBodySchema.parse(f.body({ assessment: f.issued.assessment('B') }));
    await expect(submitReviewAnswer(testDb(), changed)).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
    });
    expect((await createAttempt(nativeHttpRequest(changed))).status).toBe(409);
    expect(await effects()).toEqual(before);
  });

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
    await executeNativeAttempt(testDb(), f.job);
    expect(await effects()).toEqual(before);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('does not synchronously recommit an accepted durable original after postcommit delivery failure', async () => {
    const f = await pendingModel(true);
    expect(f.result.kind).toBe('pending');
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
    expect((await effects()).fsrs).toHaveLength(0);
    expect(await submitReviewAnswer(testDb(), f.body)).toEqual(f.result);
    expect((await createAttempt(nativeHttpRequest(f.body))).status).toBe(202);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('refuses stale background evaluation after a newer explicit candidate becomes effective', async () => {
    const f = await pendingModel();
    const [revision] = await testDb()
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, f.issued.issuance.binding.revision_id));
    const manual = await evaluateSubmission(testDb(), {
      submission_id: f.job.submit.submission_id,
      evaluation_group_id: f.job.submit.evaluation_group_id,
      evaluation_key: 'newer-owner-evidence',
      mode: 'manual_assert',
      provenance: { source: 'manual', assisted: false },
      asserted_unit_results: revision.scoring_basis.units.map((unit) => ({
        scoring_unit_id: unit.scoring_unit_id,
        status: 'scored',
        points_awarded: 0,
        scored_because: 'response',
        evidence_citations: [],
      })),
    });
    expect(
      await activateSubmissionCandidate(
        testDb(),
        {
          evaluation_id: manual.record.evaluation_id,
          expected_effective_id: null,
          expected_generation: 0,
        },
        { actorRef: 'test:explicit-user-correction' },
      ),
    ).toMatchObject({ status: 'activated' });
    const before = await effects();
    await expect(executeNativeAttempt(testDb(), f.job)).rejects.toMatchObject({
      code: 'stale_head',
    });
    expect(await effects()).toEqual(before);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['error', 'cancel'] as const)(
    'releases a diagnostic claim after %s before original acceptance',
    async (mode) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true });
      await testDb()
        .update(question)
        .set({
          source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
          judge_kind_override: 'multimodal_direct',
          draft_status: 'active',
          metadata: {
            intervention_diagnostic: {
              schema_version: INTERVENTION_CONTRACT_VERSION,
              intervention_id: 'int_original',
              intervention_version: 1,
              diagnostic_kind: 'immediate',
              knowledge_id: f.knowledgeIds[0],
              due_at: '2026-01-01T00:00:00.000Z',
            },
          },
        })
        .where(eq(question.id, f.id));
      const controller = new AbortController();
      const reason =
        mode === 'cancel'
          ? new DOMException('cancelled before capture', 'AbortError')
          : new ApiError('dispatch_unavailable', 'offline failure', 503);
      await expect(
        submitReviewAnswer(testDb(), CreateAttemptBodySchema.parse(f.body()), {
          signal: controller.signal,
          dispatchNativeAttempt: async () => {
            if (mode === 'cancel') controller.abort(reason);
            throw reason;
          },
        }),
      ).rejects.toBe(reason);
      const [row] = await testDb().select().from(question).where(eq(question.id, f.id));
      expect(row.draft_status).toBe('active');
      expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
      expect((await effects()).fsrs).toHaveLength(0);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('rejects an already cancelled request before capture or dispatch', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(
      submitReviewAnswer(testDb(), CreateAttemptBodySchema.parse(f.body()), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
    expect((await effects()).fsrs).toHaveLength(0);
  });

  it('rejects model authority, generated answers and cross-original pointers without learning writes', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    await submitReviewAnswer(testDb(), CreateAttemptBodySchema.parse(f.body()));
    const [original] = await testDb().select().from(assessment_submission);
    const pointer = {
      submission_id: original.submission_id,
      issuance_id: original.issuance_id,
      evaluation_group_id: original.evaluation_group_id,
    };
    const before = await effects();
    const ctx = {
      db: testDb(),
      taskRunId: 'untrusted-tool-call',
      callerActor: { kind: 'user' as const, ref: 'self' },
      sessionId: 'unrelated-session',
      causedByEventId: `evt_assessment_${original.submission_id}`,
    };
    for (const input of [
      { ...pointer, actor_kind: 'user', actor_ref: 'self', independent: true },
      { ...pointer, response_md: 'model generated answer', assessment: f.issued.assessment('B') },
    ])
      await expect(submitReviewAnswerTool.execute(ctx, input)).rejects.toThrow();
    for (const input of [
      pointer,
      { ...pointer, submission_id: 'invented-model-original' },
      { ...pointer, issuance_id: 'other-original-issuance' },
      { ...pointer, evaluation_group_id: 'other-original-group' },
    ])
      await expect(submitReviewAnswerTool.execute(ctx, input)).rejects.toMatchObject({
        code: 'user_submission_required',
      });
    expect(await effects()).toEqual(before);
    expect(await testDb().select().from(assessment_submission)).toEqual([original]);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
