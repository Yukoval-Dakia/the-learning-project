import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import { NativeJudgePendingSubmitInput } from '@/core/schema/event/judge-pending-events';
import {
  assessment_submission,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import {
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { CreateAttemptBodySchema } from '../api/contracts';
import { createAttempt } from '../api/submit';
import { runJudgeRun } from '../jobs/judge_run';
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
