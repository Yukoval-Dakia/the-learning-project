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
