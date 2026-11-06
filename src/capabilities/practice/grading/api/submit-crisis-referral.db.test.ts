// Crisis-marked answers surface the versioned referral in the submit response
// itself — sync 200 commit and durable 202 pending — resolved from the
// write-point mark, never the model result. The ordinary lane carries none.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CRISIS_GUARD_CONFIG_VERSION } from '@/core/crisis/config';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import { NativeJudgePendingSubmitInput } from '@/core/schema/event/judge-pending-events';
import { assessment_submission, event, material_fsrs_state } from '@/db/schema';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { __resetRateLimitForTests } from '@/kernel/request-rate-limit';
import {
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { runJudgeRun } from '../jobs/judge_run';
import { readJudgeRunStatus, readNativeJudgeSettled } from '../server/judge-run-observation';
import { createAttempt } from './submit';

vi.mock('@/kernel/background-job-enqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/kernel/background-job-enqueue')>();
  return { ...actual, shouldEnqueueBackgroundJobs: () => true };
});

const jobSchema = z.object({
  run_id: z.string(),
  caller: z.literal('native_assessment'),
  submit: NativeJudgePendingSubmitInput,
  operational: JudgeWorkflowInput,
});
const queuedJobs: z.infer<typeof jobSchema>[] = [];
const bossSend = vi.fn(async (_queue: string, data: unknown, options?: { id?: string }) => {
  queuedJobs.push(jobSchema.parse(data));
  return options?.id ?? null;
});
vi.mock('@/server/boss/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/boss/client')>();
  return { ...actual, getStartedBoss: async () => ({ send: bossSend }) };
});

const CRISIS_ANSWER = '我不想活了，这道题怎么做都没有意义。';
const ORDINARY_ANSWER = '控制水量不变，只改变坡度，比较流速差异。';

describe('submit response carries the versioned crisis referral immediately', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    bossSend.mockClear();
    queuedJobs.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // @invariant crisis: an answer marked crisis at the write point gets the versioned referral template in the accepted response, before and regardless of model grading; a durable model failure cannot remove it, and grading/settlement/FSRS still run on the marked attempt
  // @fails-if drop the persisted-mark read or gate the referral on the judge result; the 200/202 response loses crisis_referral, the model-failure assertion fails, or the settlement count drops
  it.each([
    {
      mode: 'sync' as const,
      answer: CRISIS_ANSWER,
      durable: false,
      modelOutcome: 1,
    },
    {
      mode: 'durable' as const,
      answer: CRISIS_ANSWER,
      durable: true,
      modelOutcome: 'throw' as const,
    },
    { mode: 'sync' as const, answer: ORDINARY_ANSWER, durable: false, modelOutcome: 1 },
  ])(
    'returns referral only for crisis answers ($mode)',
    async ({ mode, answer, durable, modelOutcome }) => {
      vi.stubEnv('JUDGE_DURABLE_ENABLED', durable ? '1' : '0');
      const db = testDb();
      const f = await nativeSoloHttpFixture(db, { model: true });
      f.setOutcome(modelOutcome);
      const response = await createAttempt(nativeHttpRequest({ ...f.body(), response_md: answer }));
      const crisis = answer === CRISIS_ANSWER;

      if (mode === 'durable') {
        expect(response.status).toBe(202);
        expect(f.execute).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(200);
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (!crisis) {
        expect(body.crisis_referral).toBeUndefined();
        return;
      }

      expect(body.crisis_referral).toMatchObject({
        guard_version: CRISIS_GUARD_CONFIG_VERSION,
        template: {
          version: 'full-support-v2',
          review_status: '未审定',
          text_md: expect.stringContaining('12356'),
        },
      });
      expect(
        ['explicit', 'indirect'].includes(
          (body.crisis_referral as { detection_class: string }).detection_class,
        ),
      ).toBe(true);

      const [submission] = await db.select().from(assessment_submission);
      const attemptId = assessmentAttemptEventId(submission.submission_id);
      const [attemptEvent] = await db.select().from(event).where(eq(event.id, attemptId));
      expect(attemptEvent.payload).toMatchObject({
        derivation_policy: 'crisis',
        crisis_detection_class: 'explicit',
        response_md: CRISIS_ANSWER,
      });

      // Recovery faces project the same persisted mark — refresh/reopen never
      // lose the referral. Pending settled carries it before grading lands.
      const settledEarly = await readNativeJudgeSettled(db, submission.submission_id);
      if (mode === 'durable') {
        expect(settledEarly).toMatchObject({
          kind: 'pending',
          crisis_referral: { detection_class: 'explicit' },
        });
      } else {
        expect(settledEarly).toMatchObject({
          kind: 'terminal',
          crisis_referral: { detection_class: 'explicit' },
        });
      }

      if (mode === 'sync') {
        // The marked attempt still commits effectively and settles — crisis
        // marking never blocks grading/FSRS.
        expect(await db.select().from(material_fsrs_state)).toHaveLength(1);
      }

      if (mode === 'durable') {
        // Model failure inside the worker delivery cannot revoke the
        // already-returned referral — the run completes unsupported and the
        // recovery faces still project the same persisted mark.
        const job = queuedJobs.find((queued) => queued.run_id === body.run_id);
        if (!job) throw new Error('expected mapped native delivery');
        // 'throw' outcome: the executor really throws inside the delivery; the
        // recorded executor seals it as an infra_failure pending unit — the same
        // honest degradation the live path reports — so the run completes with
        // an unsupported verdict: a model failure, not a grade.
        expect(
          await runJudgeRun(db, job, {
            retryCount: 0,
            retryLimit: 2,
            deliveryId: job.operational.delivery_id,
          }),
        ).toMatchObject({ status: 'done', coarse_outcome: 'unsupported' });

        // Settled terminal and the poll face carry the same mark-derived referral.
        const settledLate = await readNativeJudgeSettled(db, submission.submission_id);
        expect(settledLate).toMatchObject({
          kind: 'terminal',
          crisis_referral: { detection_class: 'explicit' },
        });
        const polled = await readJudgeRunStatus(db, job.run_id);
        if (polled.kind !== 'found') throw new Error('expected a found terminal run');
        expect(polled.value.result?.crisis_referral?.detection_class).toBe('explicit');
      }
    },
  );
});
