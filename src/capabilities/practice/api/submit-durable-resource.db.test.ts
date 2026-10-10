// YUK-594 (W2) — createAttemptResource must pass a 202-pending divert response
// THROUGH untouched, instead of feeding it to canonicalResourceResponse (whose
// Location derives from `review_event.id`, absent on the pending body → contract
// break). This file forces the durable divert to fire in the test env by mocking
// shouldEnqueueBackgroundJobs → true and getStartedBoss → a fake, then asserts the
// resource wrapper returns the 202 verbatim (no crash, Location preserved).

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { newId } from '@/core/ids';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import {
  JudgePendingAttemptPayload,
  NativeJudgePendingSubmitInput,
} from '@/core/schema/event/judge-pending-events';
import {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
} from '@/core/schema/intervention';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  event,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runJudgeRun } from '../jobs/judge_run';
import { issueAssessment } from '../server/assessment/issue';
import * as evaluationService from '../server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '../server/judge/recorded-model-executor';
import { fenceJudgeUnitClaim } from '../server/judge-operational';

vi.mock('@/server/runtime-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runtime-env')>();
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

import { createAttempt } from './submit';

async function seedQuestion(id: string) {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      prompt_md: `Prompt for ${id}`,
      kind: 'short_answer',
      reference_md: null,
      knowledge_ids: ['k1'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    });
}

describe('createAttemptResource — durable divert 202 pass-through (W2)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    bossSend.mockClear();
    queuedJobs.length = 0;
    vi.stubEnv('JUDGE_DURABLE_ENABLED', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retains a rate-limited diagnostic original and recovers it once without releasing its claim', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const firstQuestionId = `q_${newId()}`;
    await seedQuestion(firstQuestionId);
    const firstIssued = await issueSoloFixture(testDb(), firstQuestionId, true);
    const accepted = await createAttempt(
      new Request('http://localhost/api/attempts', {
        method: 'POST',
        body: JSON.stringify({
          question_id: firstQuestionId,
          rating: 'good',
          response_md: 'first answer',
          assessment: firstIssued.assessment('first answer'),
          auto_rate: true,
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(accepted.status).toBe(202);

    const diagnosticId = `q_${newId()}`;
    const now = new Date();
    await testDb()
      .insert(question)
      .values({
        id: diagnosticId,
        prompt_md: 'Diagnostic prompt',
        kind: 'short_answer',
        reference_md: 'Diagnostic answer',
        judge_kind_override: 'multimodal_direct',
        knowledge_ids: [],
        difficulty: 3,
        source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
        draft_status: 'active',
        variant_depth: 0,
        version: 0,
        metadata: {
          intervention_diagnostic: {
            schema_version: INTERVENTION_CONTRACT_VERSION,
            intervention_id: 'int_durable_admission',
            intervention_version: 1,
            diagnostic_kind: 'immediate',
            knowledge_id: 'kc_durable',
            due_at: '2026-07-01T00:00:00.000Z',
          },
        },
        created_at: now,
        updated_at: now,
      });

    const contract = await publishPaperModelFixture(testDb(), diagnosticId);
    const [lifecycle] = await testDb()
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, diagnosticId));
    expect(
      await publishQuestionGroup(testDb(), {
        group_id: diagnosticId,
        contract,
        expectedCurrentRevision: lifecycle.current_revision_id,
        expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
        availability: 'general_pool',
        claimPolicy: 'one_time',
        actorRef: 'test:diagnostic-one-time',
        now,
        admission: {
          state: 'admitted',
          evidence: {
            marking_provenance: 'official',
            verification: { structural_check_passed: true, independent_verification: null },
            model_slice: {
              slice_id: 'offline-paper-fixture-slice',
              holdout_cases: 35,
              severe_errors_observed: 0,
              per_criterion_agreement: 1,
              pipeline_coverage: 1,
            },
          },
        },
      }),
    ).toMatchObject({ status: 'admission_updated' });
    const diagnosticIssued = await issueSoloFixture(testDb(), diagnosticId, true);
    const assessment = diagnosticIssued.assessment('diagnostic answer');
    const submit = (original = assessment) =>
      createAttempt(
        new Request('http://localhost/api/attempts', {
          method: 'POST',
          body: JSON.stringify({
            question_id: diagnosticId,
            rating: 'good',
            response_md: 'diagnostic answer',
            assessment: original,
            auto_rate: true,
          }),
          headers: { 'content-type': 'application/json' },
        }),
      );
    const execute = vi.fn(
      async (
        input: ModelExecutorRequest,
        _signal: AbortSignal | undefined,
        runId: string,
      ): Promise<ModelUnitOutcomeT> => ({
        kind: 'scored' as const,
        points_awarded: input.unit.points,
        matched: {
          rule_id:
            input.unit.criterion.kind === 'rule_reference'
              ? input.unit.criterion.rule_id
              : 'fixture',
          option_ids: [],
        },
        feedback_md: 'Offline diagnostic recovery fixture.',
        confidence: 0.95,
        evidence_citations: [],
        run_refs: [runId],
        cost_usd_micros: 100,
      }),
    );
    vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(
      (database, _signal, _admission, execution) =>
        createRecordedModelExecutor(
          database,
          execute,
          execution ? { fence: (tx, request) => fenceJudgeUnitClaim(tx, execution, request) } : {},
        ),
    );
    const rejected = await submit();

    expect(rejected.status).toBe(429);
    const [row] = await testDb()
      .select({ draftStatus: question.draft_status })
      .from(question)
      .where(eq(question.id, diagnosticId));
    expect(row.draftStatus).toBe('draft');
    const originals = () =>
      testDb()
        .select()
        .from(assessment_submission)
        .where(eq(assessment_submission.issuance_id, assessment.issuance_id));
    const issuances = await testDb().select().from(assessment_issuance);
    expect(issuances.find((issued) => issued.issuance_id === assessment.issuance_id)).toMatchObject(
      { claim_policy: 'one_time', claim_status: 'claimed' },
    );
    const saved = await originals();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      evaluation_group_id: assessment.evaluation_group_id,
      idempotency_key: assessment.idempotency_key,
      response_set: assessment.response_set,
    });
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await testDb().select().from(event).where(eq(event.subject_id, diagnosticId)),
    ).not.toContainEqual(expect.objectContaining({ action: 'experimental:judge_pending_attempt' }));
    expect(await testDb().select().from(evaluation)).toHaveLength(0);
    expect(await issueAssessment(testDb(), { group_id: diagnosticId })).toMatchObject({
      status: 'claim_unavailable',
    });
    expect(
      (await submit({ ...assessment, idempotency_key: 'second-independent-answer' })).status,
    ).toBe(409);
    expect((await submit(diagnosticIssued.assessment('changed answer'))).status).toBe(409);
    expect(await originals()).toEqual(saved);

    __resetRateLimitForTests();
    const recovered = await submit();
    expect(recovered.status).toBe(202);
    const receipt = await recovered.json();
    expect((await submit()).status).toBe(202);
    expect(bossSend).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    const [pending] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, `evt_pending_${receipt.run_id}`));
    const payload = JudgePendingAttemptPayload.parse(pending.payload);
    if (payload.caller !== 'native_assessment') throw new Error('expected native pending receipt');
    expect(payload.submit.submission_id).toBe(saved[0].submission_id);
    const job = queuedJobs.find((queued) => queued.run_id === payload.run_id);
    if (!job) throw new Error('expected mapped diagnostic delivery');
    const meta = { retryCount: 0, retryLimit: 2, deliveryId: job.operational.delivery_id };
    expect(await runJudgeRun(testDb(), job, meta)).toMatchObject({ status: 'done' });
    expect(await runJudgeRun(testDb(), job, { ...meta, retryCount: 1 })).toMatchObject({
      status: 'skipped',
      reason: 'already_persisted',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await originals()).toEqual(saved);
    expect(await testDb().select().from(assessment_issuance)).toEqual(issuances);
    expect(await testDb().select().from(evaluation)).toHaveLength(1);
    const diagnosticEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.subject_id, diagnosticId));
    expect(
      diagnosticEvents.filter((evt) => evt.action === 'experimental:assessment_attempt'),
    ).toHaveLength(1);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_model_claim')),
    ).toHaveLength(1);
    const [retained] = await testDb().select().from(question).where(eq(question.id, diagnosticId));
    expect(retained.draft_status).toBe('draft');
    expect((await submit({ ...assessment, evaluation_group_id: 'second-group' })).status).toBe(409);
    expect(await originals()).toEqual(saved);
    expect(bossSend).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
