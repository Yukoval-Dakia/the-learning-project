import { createId } from '@paralleldrive/cuid2';
import { eq, ne, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import { NativeJudgePendingSubmitInput } from '@/core/schema/event/judge-pending-events';
import type { Db } from '@/db/client';
import {
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  job_events,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import * as domainEvents from '@/kernel/events';
import { resolveVerdictsForNativeAttempts } from '@/kernel/read-models/assessment-verdict';
import * as jobEvents from '@/server/events/writer';
import {
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import * as runtimeEnv from '@/server/runtime-env';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as pollStatus } from '../api/judge-run-status-route';
import { createAttempt } from '../api/submit';
import { runJudgeRun } from '../jobs/judge_run';
import * as formalAttempts from './assessment/attempt';
import { commitFormalAttempt } from './assessment/attempt';
import {
  NATIVE_JUDGE_RESOLUTION,
  dispatchNativeAttempt,
  executeNativeAttempt,
} from './assessment/durable-attempt';
import { issueAssessment } from './assessment/issue';
import * as evaluationService from './judge/evaluate-submission';
import { createRecordedModelExecutor } from './judge/recorded-model-executor';
import * as durableConfig from './judge-durable-config';
import { judgeDeliveryInput } from './judge-engine-client';
import { disposeJudgeRun, fenceJudgeUnitClaim } from './judge-operational';
import * as dispatch from './judge-run-dispatch';
import { readJudgeRunPermanent } from './judge-run-observation';
import type { NativeJudgeRunJobData } from './judge-run-payload';
import { NativeJudgeResolutionPayload, reconstructDoneFromDomainEvents } from './judge-run-payload';
import { JudgeRunTerminalResultSchema } from './judge-run-status';

async function fixture(knowledgeIds: string[] = []) {
  const db = testDb();
  const id = createId();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '顺流18 km/h，逆流12 km/h。列方程求静水船速并解释相加消元。',
    reference_md: '15 km/h',
    judge_kind_override: 'exact',
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'web_sourced',
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
  const [q] = await db.select().from(question).where(eq(question.id, id));
  const contract = normalizeQuestionRowToContract(q);
  contract.scoring_basis.units[0].criterion = {
    kind: 'rule_reference',
    rule_id: 'speed',
    source: 'official',
    statement_md: '建立 v+c=18、v-c=12，相加消去水速，得 v=15 km/h。单位与推导均须保留。',
  };
  contract.execution_plan.assignments[0].executor = {
    kind: 'model_executor',
    task_kind: 'AssessmentRuleJudgeTask',
    admitted_slice_id: 'speed-slice',
    max_cost_usd_micros: 1000,
  };
  contract.integrity_digest = contractIntegrityDigest(contract);
  const pub = await publishQuestionGroup(db, {
    group_id: id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:durable',
    now: new Date(),
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: {
          slice_id: 'speed-slice',
          holdout_cases: 35,
          severe_errors_observed: 0,
          per_criterion_agreement: 1,
          pipeline_coverage: 1,
        },
      },
    },
  });
  expect(pub.status).toBe('published');
  const issued = await issueAssessment(db, { group_id: id });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const request = {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: `group_${id}`,
    idempotency_key: `key_${id}`,
    response_set: {
      entries: [
        {
          slot_id: contract.response_spec.slots[0].slot_id,
          kind: 'text' as const,
          text_md: 'v+c=18，v-c=12。两式相加得到2v=30，故v=15 km/h。水速消去了。',
        },
      ],
    },
  };
  const execute = vi.fn(
    async (
      input: ModelExecutorRequest,
      _signal: AbortSignal | undefined,
      runId: string,
    ): Promise<ModelUnitOutcomeT> => ({
      kind: 'scored',
      points_awarded: input.unit.points,
      matched: { rule_id: 'speed', option_ids: [] },
      feedback_md: '原始方程和单位正确。',
      confidence: 0.95,
      evidence_citations: [{ slot_id: input.response_slots[0].slot_id, quote: '2v=30' }],
      run_refs: [runId],
      cost_usd_micros: 120,
    }),
  );
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(
    (_database, _signal, _admission, execution) =>
      createRecordedModelExecutor(
        db,
        execute,
        execution ? { fence: (tx, request) => fenceJudgeUnitClaim(tx, execution, request) } : {},
      ),
  );
  const jobs: NativeJudgeRunJobData[] = [];
  const deps = {
    checkRateLimit: vi.fn(() => 7),
    refundRateLimit: vi.fn(),
    boss: {
      send: vi.fn(async (_queue: string, data: unknown, sendOptions?: { id?: string }) => {
        jobs.push(
          z
            .object({
              run_id: z.string(),
              caller: z.literal('native_assessment'),
              submit: NativeJudgePendingSubmitInput,
              operational: JudgeWorkflowInput,
            })
            .parse(data),
        );
        return sendOptions?.id ?? null;
      }),
    },
  };
  const options = {
    enabled: true,
    capture: {
      response_md: 'observation only',
      latency_ms: 321,
      reasoning_trace: 'original process',
    },
  };
  return { db, id, request, execute, jobs, deps, options };
}

const meta = { retryCount: 0, retryLimit: 2 };
function pendingOriginal(
  questionId: string,
  submission: Awaited<
    ReturnType<typeof formalAttempts.prepareFormalAttemptSubmission>
  >['submission'],
) {
  const runId = `judge_native_${submission.submission_id}`;
  return {
    id: `evt_pending_${runId}`,
    action: dispatch.JUDGE_PENDING_ATTEMPT_ACTION,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: null,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(submission.submitted_at),
    ingest_at: new Date(submission.submitted_at),
    payload: {
      run_id: runId,
      caller: 'native_assessment',
      knowledge_ids: [],
      ability_global_ids: [],
      submit: NativeJudgePendingSubmitInput.parse({
        question_id: questionId,
        submission_id: submission.submission_id,
        evaluation_group_id: submission.evaluation_group_id,
        submitted_at: submission.submitted_at,
        expected_head: { expected_effective_id: null, expected_generation: 0 },
        capture: { reasoning_trace: 'accepted original, not retry metadata', latency_ms: 321 },
      }),
    },
  } satisfies typeof event.$inferInsert;
}
async function nativeEffects(db: Db, runId: string) {
  const [events, submissions, evaluations, heads, cards, mastery] = await Promise.all([
    db.select().from(event).where(ne(event.id, runId)).orderBy(event.id),
    db.select().from(assessment_submission).orderBy(assessment_submission.submission_id),
    db.select().from(evaluation).orderBy(evaluation.evaluation_id),
    db
      .select()
      .from(evaluation_effective_head)
      .orderBy(evaluation_effective_head.evaluation_group_id),
    db.select().from(material_fsrs_state).orderBy(material_fsrs_state.subject_id),
    db.select().from(mastery_state).orderBy(mastery_state.subject_kind, mastery_state.subject_id),
  ]);
  return { events, submissions, evaluations, heads, cards, mastery };
}

function resolutionReceipt(
  job: NativeJudgeRunJobData,
  committed: Awaited<ReturnType<typeof commitFormalAttempt>>,
) {
  const candidateId = committed.candidate.evaluation.record.evaluation_id;
  return {
    id: job.run_id,
    session_id: job.submit.capture.session_id ?? null,
    actor_kind: 'agent',
    actor_ref: 'assessment:durable_judge_run',
    action: NATIVE_JUDGE_RESOLUTION,
    subject_kind: 'question',
    subject_id: job.submit.question_id,
    outcome: null,
    caused_by_event_id: `evt_assessment_${job.submit.submission_id}`,
    payload: NativeJudgeResolutionPayload.parse({
      version: 1,
      status: 'effective',
      attempt_event_id: `evt_assessment_${job.submit.submission_id}`,
      judge_event_id: null,
      final_rating: job.submit.user_rating ?? 'good',
      ...committed.candidate.result,
      assessment: {
        submission_id: job.submit.submission_id,
        evaluation_group_id: job.submit.evaluation_group_id,
        candidate_id: candidateId,
        activation_intent: { evaluation_id: candidateId, ...job.submit.expected_head },
      },
    }),
  } satisfies Parameters<typeof domainEvents.writeEvent>[1];
}
beforeEach(async () => {
  await resetDb();
  await testDb().execute(
    sql`update judge_run_control set phase='pg-boss',epoch=0,incarnation=gen_random_uuid(),transition_event_id=null`,
  );
});
afterEach(() => vi.restoreAllMocks());

describe('native durable assessment', () => {
  it('writes the immutable resolution in the activation transaction and retains the user rating', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(
      f.db,
      f.id,
      f.request,
      {
        ...f.options,
        userRating: 'hard',
        capture: { ...f.options.capture, session_id: 'served-session' },
      },
      f.deps,
    );
    if (!run) throw new Error('expected durable run ID');
    const write = domainEvents.writeEvent;
    let resolutionWrites = 0;
    vi.spyOn(domainEvents, 'writeEvent').mockImplementation(async (database, input) => {
      if (input.action === NATIVE_JUDGE_RESOLUTION) {
        resolutionWrites++;
        for (const action of [
          'experimental:assessment_activation',
          'experimental:assessment_settlement',
        ]) {
          expect(await database.select().from(event).where(eq(event.action, action))).toHaveLength(
            1,
          );
          // A separate pool connection cannot see either native write before the receipt commits.
          expect(await f.db.select().from(event).where(eq(event.action, action))).toHaveLength(0);
        }
      }
      return write(database, input);
    });
    expect(await runJudgeRun(f.db, f.jobs[0], meta)).toMatchObject({
      status: 'done',
      coarse_outcome: 'correct',
    });
    const receipts = await f.db.select().from(event).where(eq(event.id, run));
    expect(receipts).toHaveLength(1);
    const payload = NativeJudgeResolutionPayload.parse(receipts[0].payload);
    expect(payload).toMatchObject({
      status: 'effective',
      final_rating: 'hard',
      score: 1,
      coarse_outcome: 'correct',
      assessment: { activation_intent: { expected_effective_id: null, expected_generation: 0 } },
    });
    expect(receipts[0]).toMatchObject({
      session_id: 'served-session',
      outcome: null,
      caused_by_event_id: payload.attempt_event_id,
    });
    expect(resolutionWrites).toBe(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const before = await nativeEffects(f.db, run);
    await runJudgeRun(f.db, f.jobs[0], { ...meta, retryCount: 1 });
    expect(await nativeEffects(f.db, run)).toEqual(before);
    expect(await f.db.select().from(event).where(eq(event.id, run))).toEqual(receipts);
    expect(resolutionWrites).toBe(1);
  });

  it('recovers a lost resolution COMMIT acknowledgement without rewriting the receipt or learning effects', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    if (!run) throw new Error('expected durable run ID');
    const transaction = f.db.transaction.bind(f.db);
    const write = domainEvents.writeEvent;
    let ack = false;
    let resolutionWrites = 0;
    vi.spyOn(domainEvents, 'writeEvent').mockImplementation(async (database, input) => {
      const result = await write(database, input);
      if (input.action === NATIVE_JUDGE_RESOLUTION) {
        resolutionWrites++;
        ack = true;
      }
      return result;
    });
    f.db.transaction = (body, config) =>
      transaction(body, config).then((result) => {
        if (ack) {
          ack = false;
          throw new Error('controlled resolution COMMIT acknowledgement lost');
        }
        return result;
      });
    try {
      await expect(executeNativeAttempt(f.db, f.jobs[0])).rejects.toThrow(
        'controlled resolution COMMIT acknowledgement lost',
      );
      const receipts = await f.db.select().from(event).where(eq(event.id, run));
      expect(receipts).toHaveLength(1);
      const before = await nativeEffects(f.db, run);
      expect((await runJudgeRun(f.db, f.jobs[0], { ...meta, retryCount: 1 })).status).toBe(
        'skipped',
      );
      expect(await nativeEffects(f.db, run)).toEqual(before);
      expect(await f.db.select().from(event).where(eq(event.id, run))).toEqual(receipts);
      expect(resolutionWrites).toBe(1);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(before.cards).toMatchObject([{ state: { reps: 1 } }]);
    } finally {
      f.db.transaction = transaction;
    }
  });

  it('fills a missing receipt after exact native completion, using the accepted CAS instead of the advanced head', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(
      f.db,
      f.id,
      f.request,
      { ...f.options, userRating: 'hard' },
      f.deps,
    );
    if (!run) throw new Error('expected durable run ID');
    const commit = formalAttempts.commitFormalAttempt;
    let before: Awaited<ReturnType<typeof nativeEffects>> | undefined;
    vi.spyOn(formalAttempts, 'commitFormalAttempt').mockImplementationOnce(
      async (database, entry, questionId, request, options) => {
        // Preserve the real activation/settlement, but omit the callback as in a retained native completion without its receipt.
        const committed = await commit(database, entry, questionId, request, {
          ...options,
          onActivated: undefined,
        });
        expect(await database.select().from(event).where(eq(event.id, run))).toHaveLength(0);
        expect(await readJudgeRunPermanent(database, run)).toMatchObject({
          kind: 'resolved',
          result: { status: 'effective' },
        });
        before = await nativeEffects(database, run);
        return {
          ...committed,
          activation_intent: {
            evaluation_id: committed.candidate.evaluation.record.evaluation_id,
            expected_effective_id: committed.candidate.evaluation.record.evaluation_id,
            expected_generation: 1,
          },
        };
      },
    );
    const committed = await executeNativeAttempt(f.db, f.jobs[0]);
    expect(before).toBeDefined();
    expect(await nativeEffects(f.db, run)).toEqual(before);
    const receipts = await f.db.select().from(event).where(eq(event.id, run));
    expect(receipts).toHaveLength(1);
    expect(NativeJudgeResolutionPayload.parse(receipts[0].payload)).toMatchObject({
      status: 'effective',
      final_rating: 'hard',
      assessment: {
        candidate_id: committed.candidate.evaluation.record.evaluation_id,
        activation_intent: { expected_effective_id: null, expected_generation: 0 },
      },
    });
    const result = JudgeRunTerminalResultSchema.parse(
      await reconstructDoneFromDomainEvents(f.db, run),
    );
    expect(result.assessment?.original_evaluation_id).toBe(
      committed.candidate.evaluation.record.evaluation_id,
    );
    expect(result.assessment?.effective_evaluation_id).toBe(
      committed.candidate.evaluation.record.evaluation_id,
    );
    await runJudgeRun(f.db, f.jobs[0], meta);
    expect(await nativeEffects(f.db, run)).toEqual(before);
    expect(await f.db.select().from(event).where(eq(event.id, run))).toEqual(receipts);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'user rating',
      mutate: (r) => ({ ...r, payload: { ...r.payload, final_rating: 'again' } }),
    },
    {
      name: 'verdict',
      mutate: (r) => ({ ...r, payload: { ...r.payload, score: 0, coarse_outcome: 'incorrect' } }),
    },
    {
      name: 'held status',
      mutate: (r) => ({ ...r, payload: { ...r.payload, status: 'review_required' } }),
    },
    {
      name: 'candidate',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          assessment: { ...r.payload.assessment, candidate_id: 'different-candidate' },
        },
      }),
    },
    {
      name: 'submission',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          assessment: { ...r.payload.assessment, submission_id: 'different-submission' },
        },
      }),
    },
    {
      name: 'evaluation group',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          assessment: { ...r.payload.assessment, evaluation_group_id: 'different-group' },
        },
      }),
    },
    {
      name: 'activation intent',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          assessment: {
            ...r.payload.assessment,
            activation_intent: {
              ...r.payload.assessment.activation_intent,
              expected_generation: 1,
            },
          },
        },
      }),
    },
    {
      name: 'attempt anchor',
      mutate: (r) => ({ ...r, payload: { ...r.payload, attempt_event_id: 'different-attempt' } }),
    },
    { name: 'causal envelope', mutate: (r) => ({ ...r, caused_by_event_id: 'different-attempt' }) },
    { name: 'actor', mutate: (r) => ({ ...r, actor_ref: 'different-writer' }) },
    { name: 'question', mutate: (r) => ({ ...r, subject_id: 'different-question' }) },
    { name: 'session', mutate: (r) => ({ ...r, session_id: 'different-session' }) },
    { name: 'action', mutate: (r) => ({ ...r, action: 'experimental:different_receipt' }) },
  ] satisfies {
    name: string;
    mutate: (
      receipt: ReturnType<typeof resolutionReceipt>,
    ) => Parameters<typeof domainEvents.writeEvent>[1];
  }[])(
    'fails closed on a committed same-ID receipt with a conflicting $name',
    async ({ mutate }) => {
      const f = await fixture();
      const run = await dispatchNativeAttempt(
        f.db,
        f.id,
        f.request,
        { ...f.options, userRating: 'hard' },
        f.deps,
      );
      if (!run) throw new Error('expected durable run ID');
      const commit = formalAttempts.commitFormalAttempt;
      let stored: typeof event.$inferSelect | undefined;
      let before: Awaited<ReturnType<typeof nativeEffects>> | undefined;
      vi.spyOn(formalAttempts, 'commitFormalAttempt').mockImplementationOnce(
        async (database, entry, questionId, request, options) => {
          const committed = await commit(database, entry, questionId, request, {
            ...options,
            onActivated: undefined,
          });
          await domainEvents.writeEvent(database, mutate(resolutionReceipt(f.jobs[0], committed)));
          [stored] = await database.select().from(event).where(eq(event.id, run));
          before = await nativeEffects(database, run);
          return committed;
        },
      );
      await expect(executeNativeAttempt(f.db, f.jobs[0])).rejects.toMatchObject({
        code: 'coordinate_mismatch',
      });
      expect(stored).toBeDefined();
      expect(before).toBeDefined();
      expect(await f.db.select().from(event).where(eq(event.id, run))).toEqual([stored]);
      expect(await nativeEffects(f.db, run)).toEqual(before);
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('detects writeEvent first-write-wins collisions before committing native activation', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    if (!run) throw new Error('expected durable run ID');
    const write = domainEvents.writeEvent;
    const spy = vi.spyOn(domainEvents, 'writeEvent').mockImplementation(async (database, input) => {
      if (input.action === NATIVE_JUDGE_RESOLUTION) {
        const payload = NativeJudgeResolutionPayload.parse(input.payload);
        await write(database, {
          ...input,
          payload: { ...payload, feedback_md: 'conflicting retained receipt' },
        });
      }
      // Both calls return the same ID. Only reading the stored row exposes the collision.
      return write(database, input);
    });
    await expect(executeNativeAttempt(f.db, f.jobs[0])).rejects.toMatchObject({
      code: 'coordinate_mismatch',
    });
    expect(await f.db.select().from(event).where(eq(event.id, run))).toHaveLength(0);
    expect(
      await f.db.select().from(event).where(eq(event.action, 'experimental:assessment_activation')),
    ).toHaveLength(0);
    expect(
      await f.db.select().from(event).where(eq(event.action, 'experimental:assessment_settlement')),
    ).toHaveLength(0);
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(await f.db.select().from(mastery_state)).toHaveLength(0);
    expect(await f.db.select().from(evaluation)).toHaveLength(1);
    spy.mockRestore();
    await runJudgeRun(f.db, f.jobs[0], { ...meta, retryCount: 1 });
    expect(await f.db.select().from(event).where(eq(event.id, run))).toHaveLength(1);
    expect((await f.db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('does not backfill a native receipt from a newer manual effective candidate', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    if (!run) throw new Error('expected durable run ID');
    const commit = formalAttempts.commitFormalAttempt;
    let before: Awaited<ReturnType<typeof nativeEffects>> | undefined;
    vi.spyOn(formalAttempts, 'commitFormalAttempt').mockImplementationOnce(
      async (database, entry, questionId, request, options) => {
        const committed = await commit(database, entry, questionId, request, {
          ...options,
          onActivated: undefined,
        });
        const manual = await commit(database, 'solo_submit', questionId, request, {
          selfReport: true,
          userRating: 'hard',
          expectedHead: {
            expected_effective_id: committed.candidate.evaluation.record.evaluation_id,
            expected_generation: 1,
          },
        });
        const state = await readJudgeRunPermanent(database, run);
        expect(state).toMatchObject({
          kind: 'resolved',
          result: {
            assessment: {
              candidate_id: committed.candidate.evaluation.record.evaluation_id,
              effective_evaluation_id: manual.candidate.evaluation.record.evaluation_id,
            },
          },
        });
        before = await nativeEffects(database, run);
        return committed;
      },
    );
    await expect(executeNativeAttempt(f.db, f.jobs[0])).rejects.toMatchObject({
      code: 'coordinate_mismatch',
    });
    expect(before).toBeDefined();
    expect(await nativeEffects(f.db, run)).toEqual(before);
    expect(await f.db.select().from(event).where(eq(event.id, run))).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('retains the open-run fence when manual disposition wins before a held resolution', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({
      kind: 'pending',
      pending: { reason: 'unjudgeable', detail: 'diagram insufficient' },
      run_refs: [],
      cost_usd_micros: 0,
    });
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    if (!run) throw new Error('expected durable run ID');
    const commit = formalAttempts.commitFormalAttempt;
    let before: Awaited<ReturnType<typeof nativeEffects>> | undefined;
    vi.spyOn(formalAttempts, 'commitFormalAttempt').mockImplementationOnce(async (...args) => {
      const committed = await commit(...args);
      expect(committed.status).toBe('review_required');
      await disposeJudgeRun(f.db, run, {
        reason: 'explicit_disposal',
        actorRef: 'test:before-held-resolution',
        evidenceRefs: [run],
        evidenceDigest: canonicalHash('held-receipt-fence'),
      });
      before = await nativeEffects(f.db, run);
      return committed;
    });
    await expect(executeNativeAttempt(f.db, f.jobs[0])).rejects.toMatchObject({ kind: 'disposed' });
    expect(before).toBeDefined();
    expect(await nativeEffects(f.db, run)).toEqual(before);
    expect(await f.db.select().from(event).where(eq(event.id, run))).toHaveLength(0);
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps answer-time knowledge and ability targets when tags and domains change before pickup', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      { id: 'original-kc', name: '原始知识', domain: 'math', created_at: now, updated_at: now },
      { id: 'edited-kc', name: '后来知识', domain: 'physics', created_at: now, updated_at: now },
    ]);
    const f = await fixture(['original-kc']);
    await dispatchNativeAttempt(db, f.id, f.request, f.options, f.deps);
    await db
      .update(question)
      .set({ knowledge_ids: ['edited-kc'], difficulty: 5 })
      .where(eq(question.id, f.id));
    await db.update(knowledge).set({ domain: 'physics' }).where(eq(knowledge.id, 'original-kc'));
    await runJudgeRun(db, f.jobs[0], meta);
    const cards = await db.select().from(material_fsrs_state);
    expect.soft(cards.map((row) => row.subject_id)).toEqual(['original-kc']);
    const mastery = await db.select().from(mastery_state);
    expect
      .soft(mastery.filter((row) => row.subject_kind === 'knowledge').map((row) => row.subject_id))
      .toEqual(['original-kc']);
    expect
      .soft(
        mastery.filter((row) => row.subject_kind === 'ability_global').map((row) => row.subject_id),
      )
      .toEqual(['math']);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const [initial] = await db.select().from(evaluation);
    const correction = await evaluationService.evaluateSubmission(db, {
      submission_id: initial.submission_id,
      evaluation_group_id: initial.evaluation_group_id,
      evaluation_key: 'correct-with-original-learning-scope',
      model_executor: createRecordedModelExecutor(db, async (_input, _signal, runId) => ({
        kind: 'scored',
        points_awarded: 0,
        matched: { rule_id: 'speed', option_ids: [] },
        feedback_md: '更正原作答评分',
        confidence: 0.95,
        evidence_citations: [],
        run_refs: [runId],
        cost_usd_micros: 100,
      })),
      provenance: { source: 'automatic', assisted: false },
    });
    const activation = await evaluationService.activateSubmissionCandidate(
      db,
      {
        evaluation_id: correction.record.evaluation_id,
        expected_effective_id: initial.evaluation_id,
        expected_generation: 1,
      },
      { actorRef: 'test:scope-correction' },
    );
    expect(activation).toMatchObject({ status: 'activated', effect: 'applied' });
    expect(
      (await db.select().from(material_fsrs_state)).map((row) => ({
        id: row.subject_id,
        reps: row.state.reps,
      })),
    ).toEqual([{ id: 'original-kc', reps: 1 }]);
    expect((await db.select().from(mastery_state)).map((row) => row.subject_id).sort()).toEqual([
      'math',
      'original-kc',
    ]);
    const receipts = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts)
      expect(receipt.payload.replay_inputs).toMatchObject({
        theta: {
          anchorDifficulty: 3,
          knowledgeIds: ['original-kc'],
          abilityGlobalByKnowledgeId: { 'original-kc': 'math' },
        },
      });
  });

  it('preserves an absent answer-time ability domain instead of resolving a newly added one', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'orphan-kc',
      name: '未归属知识',
      domain: null,
      created_at: now,
      updated_at: now,
    });
    const f = await fixture(['orphan-kc']);
    await dispatchNativeAttempt(db, f.id, f.request, f.options, f.deps);
    await db.update(knowledge).set({ domain: 'math' }).where(eq(knowledge.id, 'orphan-kc'));
    await runJudgeRun(db, f.jobs[0], meta);
    expect((await db.select().from(mastery_state)).map((row) => row.subject_id)).toEqual([
      'orphan-kc',
    ]);
  });

  it('preserves an old queued answer but refuses to execute the retired scoring route', async () => {
    const f = await fixture();
    const legacy = {
      run_id: 'retired_legacy_run',
      caller: 'submit' as const,
      submit: {
        body: { question_id: f.id, rating: 'good', auto_rate: true, response_md: '15 km/h' },
        question_id: f.id,
        subject_profile: resolveSubjectProfile(),
        submitted_at: new Date().toISOString(),
      },
    };
    await dispatch.recordJudgePendingAttempt(f.db, {
      runId: legacy.run_id,
      sessionId: null,
      questionId: f.id,
      knowledgeIds: [],
      submit: legacy.submit,
      submittedAt: new Date(legacy.submit.submitted_at),
    });
    const before = await f.db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:judge_pending_attempt'));
    const result = await runJudgeRun(f.db, legacy, meta);
    expect.soft(result.status).toBe('failed');
    expect.soft(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(
      await f.db.select().from(event).where(eq(event.action, 'experimental:judge_pending_attempt')),
    ).toEqual(before);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('freezes originals before enqueue; concurrent HTTP retries and worker redelivery settle once', async () => {
    const f = await fixture();
    const runs = await Promise.all([
      dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps),
      dispatchNativeAttempt(
        f.db,
        f.id,
        f.request,
        { ...f.options, capture: { latency_ms: 999 } },
        f.deps,
      ),
    ]);
    const [runId] = runs;
    expect(runId).toBeTruthy();
    if (!runId) throw new Error('expected durable run ID');
    expect(runId).toBe(runs[1]);
    expect(f.deps.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(f.jobs).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    const anchors = await f.db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].outcome).toBeNull();
    expect(
      (await resolveVerdictsForNativeAttempts(f.db, anchors)).get(anchors[0].id)
        ?.original_evaluation_id,
    ).toBeNull();
    await f.db
      .update(question)
      .set({ prompt_md: '已更改的新题', reference_md: '999' })
      .where(eq(question.id, f.id));
    await Promise.all([runJudgeRun(f.db, f.jobs[0], meta), runJudgeRun(f.db, f.jobs[0], meta)]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][0].question_parts[0].prompt_md).toContain('18');
    expect(f.execute.mock.calls[0][0].slot_responses).toEqual(f.request.response_set.entries);
    expect(await f.db.select().from(evaluation)).toHaveLength(1);
    const [card] = await f.db.select().from(material_fsrs_state);
    expect(card.state.reps).toBe(1);
    const restored = JudgeRunTerminalResultSchema.parse(
      await reconstructDoneFromDomainEvents(f.db, runId),
    );
    expect(restored.status).toBe('effective');
    expect(restored.judge_event_id).toBeNull();
    expect(restored.assessment?.original_evaluation_id).toBe(restored.assessment?.candidate_id);
    await f.db.delete(job_events);
    expect((await runJudgeRun(f.db, f.jobs[0], meta)).status).toBe('skipped');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(
      await dispatchNativeAttempt(f.db, f.id, f.request, { ...f.options, enabled: false }, f.deps),
    ).toBe(runs[0]);
    expect(f.jobs).toHaveLength(1);
    await expect(
      dispatchNativeAttempt(f.db, f.id, f.request, { ...f.options, userRating: 'again' }, f.deps),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
    await expect(
      dispatchNativeAttempt(
        f.db,
        f.id,
        f.request,
        { ...f.options, enabled: false, requireUnassistedModelEvidence: true },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
    expect(f.deps.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(f.deps.refundRateLimit).not.toHaveBeenCalled();
    expect(f.jobs).toHaveLength(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.db.select().from(evaluation)).toHaveLength(1);
    expect((await f.db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
  });

  it.each([
    { name: 'changed rating', accepted: { userRating: 'hard' }, retry: { userRating: 'again' } },
    { name: 'removed rating', accepted: { userRating: 'hard' }, retry: { userRating: undefined } },
    {
      name: 'relaxed unassisted policy',
      accepted: { requireUnassistedModelEvidence: true },
      retry: { requireUnassistedModelEvidence: false },
    },
    {
      name: 'tightened unassisted policy',
      accepted: { requireUnassistedModelEvidence: false },
      retry: { requireUnassistedModelEvidence: true },
    },
  ] satisfies {
    name: string;
    accepted: Partial<Parameters<typeof dispatchNativeAttempt>[3]>;
    retry: Partial<Parameters<typeof dispatchNativeAttempt>[3]>;
  }[])(
    'rejects $name against a committed pending original without swallowing it in recovery',
    async ({ accepted, retry }) => {
      const f = await fixture();
      const options = { ...f.options, ...accepted };
      const runId = await dispatchNativeAttempt(f.db, f.id, f.request, options, f.deps);
      if (!runId) throw new Error('expected accepted original');
      const before = await nativeEffects(f.db, runId);
      for (const enabled of [true, false]) {
        await expect(
          dispatchNativeAttempt(f.db, f.id, f.request, { ...options, ...retry, enabled }, f.deps),
        ).rejects.toMatchObject({ code: 'coordinate_mismatch' });
      }
      expect(
        await dispatchNativeAttempt(
          f.db,
          f.id,
          f.request,
          { ...options, enabled: false, capture: { latency_ms: 999 } },
          f.deps,
        ),
      ).toBe(runId);
      expect(await nativeEffects(f.db, runId)).toEqual(before);
      expect(f.deps.checkRateLimit).toHaveBeenCalledTimes(1);
      expect(f.deps.refundRateLimit).not.toHaveBeenCalled();
      expect(f.jobs).toHaveLength(1);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'run', mutate: (r) => ({ ...r, payload: { ...r.payload, run_id: 'other-run' } }) },
    {
      name: 'question',
      mutate: (r) => ({
        ...r,
        payload: { ...r.payload, submit: { ...r.payload.submit, question_id: 'other-question' } },
      }),
    },
    {
      name: 'submission',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          submit: { ...r.payload.submit, submission_id: 'other-submission' },
        },
      }),
    },
    {
      name: 'evaluation group',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          submit: { ...r.payload.submit, evaluation_group_id: 'other-group' },
        },
      }),
    },
    {
      name: 'answer time',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          submit: {
            ...r.payload.submit,
            submitted_at: new Date(r.created_at.getTime() + 1000).toISOString(),
          },
        },
      }),
    },
    {
      name: 'initial effective head',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          submit: {
            ...r.payload.submit,
            expected_head: { expected_effective_id: 'other-candidate', expected_generation: 0 },
          },
        },
      }),
    },
    {
      name: 'initial head generation',
      mutate: (r) => ({
        ...r,
        payload: {
          ...r.payload,
          submit: {
            ...r.payload.submit,
            expected_head: { expected_effective_id: null, expected_generation: 1 },
          },
        },
      }),
    },
    { name: 'action', mutate: (r) => ({ ...r, action: 'experimental:other_pending' }) },
    { name: 'actor kind', mutate: (r) => ({ ...r, actor_kind: 'agent' }) },
    { name: 'actor reference', mutate: (r) => ({ ...r, actor_ref: 'other-writer' }) },
    { name: 'question subject kind', mutate: (r) => ({ ...r, subject_kind: 'submission' }) },
    { name: 'question subject', mutate: (r) => ({ ...r, subject_id: 'other-question' }) },
    { name: 'session', mutate: (r) => ({ ...r, session_id: 'other-session' }) },
    { name: 'outcome', mutate: (r) => ({ ...r, outcome: 'success' }) },
    { name: 'causal envelope', mutate: (r) => ({ ...r, caused_by_event_id: 'other-cause' }) },
    { name: 'task run', mutate: (r) => ({ ...r, task_run_id: 'other-task' }) },
    { name: 'cost', mutate: (r) => ({ ...r, cost_micro_usd: 10 }) },
    {
      name: 'event time',
      mutate: (r) => ({ ...r, created_at: new Date(r.created_at.getTime() + 1000) }),
    },
    {
      name: 'malformed payload',
      mutate: (r) => ({
        ...r,
        payload: { run_id: r.payload.run_id, caller: 'native_assessment', submit: {} },
      }),
    },
  ] satisfies {
    name: string;
    mutate: (original: ReturnType<typeof pendingOriginal>) => typeof event.$inferInsert;
  }[])(
    'refuses a committed same-ID pending original with conflicting $name',
    async ({ mutate }) => {
      const f = await fixture();
      const prepared = await formalAttempts.prepareFormalAttemptSubmission(
        f.db,
        'durable_judge_run',
        f.id,
        f.request,
      );
      const original = pendingOriginal(f.id, prepared.submission);
      // Seed corrupt persisted truth directly. The live event parser must not hide the negative.
      await f.db.insert(event).values(mutate(original));
      const before = await nativeEffects(f.db, original.payload.run_id);
      await expect(
        dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps),
      ).rejects.toThrow();
      expect(await nativeEffects(f.db, original.payload.run_id)).toEqual(before);
      expect(f.deps.checkRateLimit).not.toHaveBeenCalled();
      expect(f.deps.refundRateLimit).not.toHaveBeenCalled();
      expect(f.jobs).toHaveLength(0);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('persists queue failure for reconciliation and refuses admission without a pending receipt', async () => {
    const f = await fixture();
    f.deps.checkRateLimit.mockImplementationOnce(() => {
      throw new Error('rate limited');
    });
    await expect(dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps)).rejects.toThrow(
      'rate limited',
    );
    expect(
      await f.db.select().from(event).where(eq(event.action, 'experimental:judge_pending_attempt')),
    ).toHaveLength(0);
    f.deps.boss.send.mockRejectedValueOnce(new Error('queue unavailable'));
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    expect(run).toBeTruthy();
    if (!run) throw new Error('expected durable run ID');
    expect(f.deps.refundRateLimit).not.toHaveBeenCalled();
    const [pending] = await f.db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:judge_pending_attempt'));
    expect(pending.payload).toMatchObject({ run_id: run, caller: 'native_assessment' });
    const job = {
      run_id: run,
      caller: 'native_assessment' as const,
      submit: pending.payload.submit as NativeJudgeRunJobData['submit'],
    };
    await runJudgeRun(f.db, job, meta);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('recovers a failed DONE notification from atomic domain completion without another model call', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    expect(run).toBeTruthy();
    if (!run) throw new Error('expected durable run ID');
    const original = jobEvents.writeJobEvent;
    const spy = vi.spyOn(jobEvents, 'writeJobEvent').mockImplementation(async (...args) => {
      if (args[1].event_type === 'judge_run.done') throw new Error('DONE failed');
      return original(...args);
    });
    await expect(runJudgeRun(f.db, f.jobs[0], meta)).rejects.toThrow('DONE failed');
    expect(await f.db.select().from(event).where(eq(event.id, run))).toHaveLength(1);
    spy.mockRestore();
    await runJudgeRun(f.db, f.jobs[0], { ...meta, retryCount: 1 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
  });

  it('rolls activation back if durable completion fails, then reuses the sealed candidate', async () => {
    const f = await fixture();
    await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    const original = domainEvents.writeEvent;
    const spy = vi.spyOn(domainEvents, 'writeEvent').mockImplementation(async (...args) => {
      if (args[1].action === 'experimental:assessment_judge_resolution')
        throw new Error('receipt failed');
      return original(...args);
    });
    await expect(runJudgeRun(f.db, f.jobs[0], meta)).rejects.toThrow('receipt failed');
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    spy.mockRestore();
    await runJudgeRun(f.db, f.jobs[0], { ...meta, retryCount: 1 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
  });

  it('keeps unjudgeable work unscored; later self-report does not replace the first evaluation reference', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({
      kind: 'pending',
      pending: { reason: 'unjudgeable', detail: 'diagram insufficient' },
      run_refs: [],
      cost_usd_micros: 0,
    });
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    expect(run).toBeTruthy();
    if (!run) throw new Error('expected durable run ID');
    await runJudgeRun(f.db, f.jobs[0], meta);
    const first = JudgeRunTerminalResultSchema.parse(
      await reconstructDoneFromDomainEvents(f.db, run),
    );
    const receipts = await f.db.select().from(event).where(eq(event.id, run));
    expect(receipts).toHaveLength(1);
    expect(first.status).toBe('review_required');
    expect(first.coarse_outcome).toBe('unsupported');
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    await commitFormalAttempt(f.db, 'solo_submit', f.id, f.request, {
      selfReport: true,
      userRating: 'hard',
    });
    const later = JudgeRunTerminalResultSchema.parse(
      await reconstructDoneFromDomainEvents(f.db, run),
    );
    expect(later.assessment?.original_evaluation_id).toBe(first.assessment?.candidate_id);
    expect(later.final_rating).toBe('hard');
    expect(later.coarse_outcome).toBe('unsupported');
    expect(later.assessment?.effective_evaluation_id).not.toBe(first.assessment?.candidate_id);
    expect(await f.db.select().from(event).where(eq(event.id, run))).toEqual(receipts);
    expect((await f.db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
  });
  it('rejects a changed queue payload before execution and keeps the accepted original', async () => {
    const f = await fixture();
    await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    const tampered = {
      ...f.jobs[0],
      submit: { ...f.jobs[0].submit, user_rating: 'again' as const },
    };
    expect((await runJudgeRun(f.db, tampered, meta)).status).toBe('failed');
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(
      await f.db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
  });

  it('does not pay to overwrite a self-report activated while the original was queued', async () => {
    const f = await fixture();
    await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    const selfReport = await commitFormalAttempt(f.db, 'solo_submit', f.id, f.request, {
      selfReport: true,
      userRating: 'good',
    });
    expect((await runJudgeRun(f.db, f.jobs[0], meta)).status).toBe('failed');
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.db.select().from(evaluation)).toHaveLength(1);
    expect((await f.db.select().from(material_fsrs_state))[0].state.reps).toBe(1);
    const anchors = await f.db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(
      (await resolveVerdictsForNativeAttempts(f.db, anchors)).get(anchors[0].id)?.effective
        ?.evaluation_id,
    ).toBe(selfReport.candidate.evaluation.record.evaluation_id);
  });
  it('returns a real HTTP 202 handle and polls native completion with evaluation anchors', async () => {
    const f = await fixture();
    vi.spyOn(runtimeEnv, 'shouldEnqueueBackgroundJobs').mockReturnValue(true);
    vi.spyOn(durableConfig, 'judgeDurableEnabled').mockReturnValue(true);
    vi.spyOn(dispatch, 'admitJudgeRun').mockReturnValue(12);
    vi.spyOn(dispatch, 'enqueueJudgeRun').mockImplementation(async (job, _deps, opts) => {
      if (job.caller !== 'native_assessment') throw new Error('unexpected legacy route');
      if (!opts?.authorization) throw new Error('Missing durable authority');
      f.jobs.push({ ...job, operational: judgeDeliveryInput(opts.authorization.reservation) });
      return opts.authorization.reservation.delivery_id;
    });
    const response = await createAttempt(
      new Request('http://localhost/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: f.id,
          assessment: f.request,
          rating: 'good',
          auto_rate: true,
        }),
      }),
    );
    expect(response.status).toBe(202);
    const pending = await response.json();
    expect(pending.backfill.poll_url).toContain(pending.run_id);
    expect(f.execute).not.toHaveBeenCalled();
    await runJudgeRun(f.db, f.jobs[0], meta);
    const polled = await pollStatus(new Request(`http://localhost${pending.backfill.poll_url}`), {
      id: pending.run_id,
    });
    expect(polled.status).toBe(200);
    const done = await polled.json();
    expect(done).toMatchObject({
      status: 'done',
      result: {
        status: 'effective',
        final_rating: 'good',
        judge_event_id: null,
        coarse_outcome: 'correct',
        assessment: { evaluation_group_id: f.request.evaluation_group_id },
      },
    });
    expect(done.result.assessment.original_evaluation_id).toBe(done.result.assessment.candidate_id);
  });
});
