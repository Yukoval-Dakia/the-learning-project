import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import {
  evaluation,
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
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as pollStatus } from '../api/judge-run-status-route';
import { createAttempt } from '../api/submit';
import { runJudgeRun } from '../jobs/judge_run';
import { commitFormalAttempt } from './assessment/attempt';
import { dispatchNativeAttempt } from './assessment/durable-attempt';
import { issueAssessment } from './assessment/issue';
import * as evaluationService from './judge/evaluate-submission';
import { createRecordedModelExecutor } from './judge/recorded-model-executor';
import * as durableConfig from './judge-durable-config';
import * as dispatch from './judge-run-dispatch';
import type { NativeJudgeRunJobData } from './judge-run-payload';
import { reconstructDoneFromDomainEvents } from './judge-run-payload';
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
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
    createRecordedModelExecutor(db, execute),
  );
  const jobs: NativeJudgeRunJobData[] = [];
  const deps = {
    checkRateLimit: vi.fn(() => 7),
    refundRateLimit: vi.fn(),
    boss: {
      send: vi.fn(async (_queue: string, data: unknown) => {
        jobs.push(data as NativeJudgeRunJobData);
        return createId();
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
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('native durable assessment', () => {
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
      model_executor: createRecordedModelExecutor(db, async (input, _signal, runId) => ({
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
    await db
      .insert(knowledge)
      .values({
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
    expect(runs[0]).toBe(runs[1]);
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
      await reconstructDoneFromDomainEvents(f.db, runs[0]!),
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
  });

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
    expect(f.deps.refundRateLimit).toHaveBeenCalledTimes(1);
    const [pending] = await f.db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:judge_pending_attempt'));
    expect(pending.payload).toMatchObject({ run_id: run, caller: 'native_assessment' });
    const job = {
      run_id: run!,
      caller: 'native_assessment' as const,
      submit: pending.payload.submit as NativeJudgeRunJobData['submit'],
    };
    await runJudgeRun(f.db, job, meta);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('recovers a failed DONE notification from atomic domain completion without another model call', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, f.deps);
    const original = jobEvents.writeJobEvent;
    const spy = vi.spyOn(jobEvents, 'writeJobEvent').mockImplementation(async (...args) => {
      if (args[1].event_type === 'judge_run.done') throw new Error('DONE failed');
      return original(...args);
    });
    await expect(runJudgeRun(f.db, f.jobs[0], meta)).rejects.toThrow('DONE failed');
    expect(await f.db.select().from(event).where(eq(event.id, run!))).toHaveLength(1);
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
    await runJudgeRun(f.db, f.jobs[0], meta);
    const first = JudgeRunTerminalResultSchema.parse(
      await reconstructDoneFromDomainEvents(f.db, run!),
    );
    expect(first.status).toBe('review_required');
    expect(first.coarse_outcome).toBe('unsupported');
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    await commitFormalAttempt(f.db, 'solo_submit', f.id, f.request, {
      selfReport: true,
      userRating: 'hard',
    });
    const later = JudgeRunTerminalResultSchema.parse(
      await reconstructDoneFromDomainEvents(f.db, run!),
    );
    expect(later.assessment?.original_evaluation_id).toBe(first.assessment?.candidate_id);
    expect(later.final_rating).toBe('hard');
    expect(later.coarse_outcome).toBe('unsupported');
    expect(later.assessment?.effective_evaluation_id).not.toBe(first.assessment?.candidate_id);
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
    vi.spyOn(dispatch, 'enqueueJudgeRun').mockImplementation(async (job) => {
      if (job.caller !== 'native_assessment') throw new Error('unexpected legacy route');
      f.jobs.push(job);
      return createId();
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
