import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import type { ResponseSetT } from '@/core/schema/assessment';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import {
  JudgePendingAttemptPayload,
  NativeJudgePendingSubmitInput,
} from '@/core/schema/event/judge-pending-events';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { activateEvaluation } from '@/server/assessment/activate';
import { normalizeQuestionGroupToContract } from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import {
  correctPaperFixture,
  publishPaperModelFixture,
} from '../../../../tests/fixtures/assessment-paper';
import {
  publishPlacementFixture,
  seedPlacementRuntimeFixture,
} from '../../../../tests/fixtures/assessment-placement';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { RECONCILE_STALL_MS, reconcileStalledJudgeAttempts } from '../jobs/judge_pending_reconcile';
import { runJudgeRun } from '../jobs/judge_run';
import { dispatchNativeAttempt, executeNativeAttempt } from '../server/assessment/durable-attempt';
import type { SaveSubmissionRequest } from '../server/assessment/submit';
import { saveSubmission } from '../server/assessment/submit';
import * as evaluationService from '../server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '../server/judge/recorded-model-executor';
import { fenceJudgeUnitClaim } from '../server/judge-operational';
import { readJudgeRunPermanent } from '../server/judge-run-observation';
import type { NativeJudgeRunJobData } from '../server/judge-run-payload';
import {
  PlacementQuestionSelectionResponseSchema,
  PlacementSessionCreatedSchema,
} from './placement-contracts';
import { createPlacementQuestionSelection as next } from './placement-next';
import { createPlacementSession as start } from './placement-start';
import { createAttemptResource as submit } from './submit';

const db = testDb();
const request = (body: unknown) =>
  new Request('http://test/api/placement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(async () => {
  await resetDb();
  setTestConfig({ PLACEMENT_PROBE_ENABLED: true });
});
afterEach(() => {
  resetTestConfig();
  vi.restoreAllMocks();
});
async function seed(id = 'q1', publish = true) {
  const now = new Date();
  const [kc] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc1'));
  if (!kc)
    await db.insert(knowledge).values({
      id: 'kc1',
      name: '变化率',
      domain: 'math',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `在非零分母条件下化简分式。${id}`,
    reference_md: 'fixture answer',
    judge_kind_override: 'exact',
    knowledge_ids: ['kc1'],
    difficulty: 3,
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  if (publish) await publishPlacementFixture(db, id);
}
async function open() {
  const response = await start(request({ knowledgeIds: ['kc1'] }));
  expect(response.status).toBe(200);
  const session = PlacementSessionCreatedSchema.parse(await response.json());
  if (!session.question) throw new Error('missing placement question');
  return { ...session, question: session.question };
}
type Open = Awaited<ReturnType<typeof open>>;
function original(
  session: Open,
  text = 'fixture answer',
): SaveSubmissionRequest & { submission_id: string } {
  const binding = session.question.assessment;
  const spec = binding.state.practice_dto?.response_spec.slots.find((s) => s.kind !== 'table');
  if (!spec) throw new Error('missing response slot');
  const responseSet: ResponseSetT = {
    entries: [{ slot_id: spec.slot_id, kind: 'text', text_md: text }],
  };
  return {
    issuance_id: binding.issuance_id,
    submission_id: binding.submission_id,
    evaluation_group_id: binding.evaluation_group_id,
    idempotency_key: binding.idempotency_key,
    response_set: responseSet,
    group_evidence: [],
  };
}
async function selection(sessionId: string, body: unknown = {}) {
  const response = await next(request(body), { id: sessionId });
  expect(response.status).toBe(200);
  return PlacementQuestionSelectionResponseSchema.parse(await response.json());
}
async function answer(session: Open, assessment = original(session)) {
  return submit(
    request({
      question_id: session.question.questionId,
      session_id: session.sessionId,
      rating: 'good',
      auto_rate: true,
      response_md: 'observational text',
      latency_ms: 3456,
      referenced_knowledge_ids: [],
      assessment,
    }),
  );
}

describe('placement frozen native workflow', () => {
  it('recovers the identical issuance on concurrent next, refresh and lost selection responses', async () => {
    await seed();
    await seed('q2');
    const session = await open();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => selection(session.sessionId)),
    );
    for (const response of responses) {
      expect(response.done).toBe(false);
      if (response.done) throw new Error('not done');
      expect(response.question).toEqual(session.question);
    }
    expect(await db.select().from(assessment_issuance)).toHaveLength(1);
    await db
      .update(question)
      .set({ prompt_md: 'mutable current text', reference_md: 'changed key' })
      .where(eq(question.id, 'q1'));
    const restored = await selection(session.sessionId);
    if (restored.done) throw new Error('not done');
    expect(restored.question?.assessment.state.practice_dto).toEqual(
      session.question.assessment.state.practice_dto,
    );
    const result = await answer(session);
    expect(result.status).toBe(201);
    expect((await result.json()).status).toBe('effective');
    const nextResponses = await Promise.all([
      selection(session.sessionId),
      selection(session.sessionId),
    ]);
    expect(nextResponses[0]).toEqual(nextResponses[1]);
    expect(nextResponses[0]).toMatchObject({ answeredCount: 1, question: { questionId: 'q2' } });
    expect(await db.select().from(assessment_issuance)).toHaveLength(2);
  });

  it('counts native participation once and preserves once-only theta and FSRS on duplicate commits', async () => {
    await seed();
    const session = await open();
    expect((await answer(session)).status).toBe(201);
    const state1 = {
      mastery: await db.select().from(mastery_state),
      fsrs: await db.select().from(material_fsrs_state),
    };
    expect(state1.mastery.some((row) => row.subject_id === 'kc1' && row.evidence_count === 1)).toBe(
      true,
    );
    expect(state1.fsrs.length).toBeGreaterThan(0);
    expect((await answer(session)).status).toBe(201);
    expect(await db.select().from(mastery_state)).toEqual(state1.mastery);
    expect(await db.select().from(material_fsrs_state)).toEqual(state1.fsrs);
    expect(await db.select().from(assessment_submission)).toHaveLength(1);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
    expect(await selection(session.sessionId, { cap: 1 })).toEqual({
      done: true,
      reason: 'cap',
      answeredCount: 1,
    });
  });

  it('restores accepted originals before their participation anchor and permits only identical retries', async () => {
    await seed();
    const session = await open();
    const input = original(session, 'fixture answer');
    expect((await saveSubmission(db, input)).status).toBe('saved');
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(0);
    const recovered = await selection(session.sessionId, { cap: 1 });
    expect(recovered).toMatchObject({
      done: false,
      answeredCount: 1,
      question: {
        assessment: {
          phase: 'retry',
          pending_run: null,
          state: {
            submissions: [{ submission_id: input.submission_id, response_set: input.response_set }],
          },
        },
      },
    });
    const changed = original(session, 'different');
    expect((await answer(session, changed)).status).toBe(409);
    expect((await answer(session, input)).status).toBe(201);
    expect(await selection(session.sessionId, { cap: 1 })).toMatchObject({
      done: true,
      answeredCount: 1,
    });
  });

  it('gates a sealed unresolved original before cap, never creates another issuance or invents a run handle', async () => {
    await seed();
    await seed('q2');
    const session = await open();
    const held = await answer(session, original(session, ''));
    expect(held.status).toBe(201);
    // Empty text follows the published blank policy; make an explicitly unsupported photo-only original in a fresh session.
    const session2 = await open();
    const input = {
      ...original(session2),
      response_set: { entries: [] },
      group_evidence: [
        {
          evidence: {
            evidence_id: 'photo',
            kind: 'image' as const,
            asset: { asset_id: 'photo', digest: 'sha256:photo' },
            mime_type: 'image/png',
            bytes: 200,
            uploaded_at: '2026-10-05T00:00:00.000Z',
          },
          target: { scope: 'all_units' as const },
        },
      ],
    };
    const response = await answer(session2, input);
    expect(response.status).toBe(201);
    expect((await response.json()).status).toBe('review_required');
    const recovered = await selection(session2.sessionId, { cap: 1 });
    expect(recovered).toMatchObject({
      done: false,
      answeredCount: 1,
      question: { assessment: { phase: 'held', pending_run: null } },
    });
    const count = (await db.select().from(assessment_issuance)).length;
    expect(await selection(session2.sessionId)).toEqual(recovered);
    expect(await db.select().from(assessment_issuance)).toHaveLength(count);
    expect(
      await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:assessment_attempt'),
            eq(event.session_id, session2.sessionId),
          ),
        ),
    ).toHaveLength(1);
  });

  it('requires successful settlement for the effective head; failed_pending remains held', async () => {
    await seed();
    const session = await open();
    const input = original(session);
    await saveSubmission(db, input);
    const candidate = await evaluationService.evaluateSubmission(db, {
      submission_id: input.submission_id,
      evaluation_group_id: input.evaluation_group_id,
      evaluation_key: `submission:${input.submission_id}`,
      provenance: { source: 'automatic', assisted: false },
    });
    const activation = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        {
          evaluation_id: candidate.record.evaluation_id,
          expected_effective_id: null,
          expected_generation: 0,
        },
        {
          settle: async ({ tx }) => {
            await writeEvent(tx, {
              id: 'failed_settlement',
              actor_kind: 'system',
              actor_ref: 'test:settlement-failure',
              action: 'experimental:assessment_settlement',
              subject_kind: 'evaluation_group',
              subject_id: input.evaluation_group_id,
              outcome: null,
              payload: { evaluation_id: candidate.record.evaluation_id, effect: 'replay_required' },
            });
            return 'failed_pending';
          },
        },
      ),
    );
    expect(activation).toMatchObject({ status: 'activated', effect: 'failed_pending' });
    expect((await db.select().from(evaluation_effective_head))[0].effective_evaluation_id).toBe(
      candidate.record.evaluation_id,
    );
    const recovered = await selection(session.sessionId, { cap: 1 });
    expect(recovered).toMatchObject({
      done: false,
      answeredCount: 1,
      question: { assessment: { phase: 'held' } },
    });
    expect(JSON.stringify(recovered)).not.toContain('coarse_outcome');
    expect(await db.select().from(mastery_state)).toHaveLength(0);
  });

  it.each(['accepted', 'queue unavailable'] as const)(
    'recovers an %s delivery from permanent authority, waits before cap, and settles once',
    async (delivery) => {
      await seed();
      await publishPaperModelFixture(db, 'q1');
      const session = await open();
      const input = original(session, '方程和条件均已列出。');
      await saveSubmission(db, input);
      expect(await readJudgeRunPermanent(db, `judge_native_${input.submission_id}`)).toEqual({
        kind: 'absent',
      });
      expect(await selection(session.sessionId, { cap: 1 })).toMatchObject({
        done: false,
        answeredCount: 1,
        question: { assessment: { phase: 'retry', pending_run: null } },
      });
      const jobs: Array<
        NativeJudgeRunJobData & { operational: z.infer<typeof JudgeWorkflowInput> }
      > = [];
      const send = vi.fn(async (_queue: string, data: unknown, options?: { id?: string }) => {
        const parsed = z
          .object({
            run_id: z.string(),
            caller: z.literal('native_assessment'),
            submit: NativeJudgePendingSubmitInput,
            operational: JudgeWorkflowInput,
          })
          .parse(data);
        expect(options?.id).toBe(parsed.operational.delivery_id);
        jobs.push(parsed);
        return options?.id ?? null;
      });
      if (delivery === 'queue unavailable') send.mockRejectedValueOnce(new Error(delivery));
      const deps = { checkRateLimit: vi.fn(() => 1), boss: { send } };
      const runId = await dispatchNativeAttempt(
        db,
        'q1',
        input,
        { enabled: true, capture: { session_id: session.sessionId } },
        deps,
      );
      if (!runId) throw new Error('missing accepted durable run');
      expect(jobs).toHaveLength(delivery === 'accepted' ? 1 : 0);
      const beforeRecovery = await readJudgeRunPermanent(db, runId);
      expect(beforeRecovery).toMatchObject({
        kind: 'pending',
        delivery: { kind: delivery === 'accepted' ? 'accepted' : 'send_unknown' },
      });
      const [pending] = await db
        .select()
        .from(event)
        .where(eq(event.id, `evt_pending_${runId}`));
      const accepted = JudgePendingAttemptPayload.parse(pending.payload);
      if (accepted.caller !== 'native_assessment') throw new Error('unexpected historical pending');
      await expect(
        executeNativeAttempt(db, {
          run_id: runId,
          caller: accepted.caller,
          submit: accepted.submit,
        }),
      ).rejects.toMatchObject({ code: 'judge_authorization_required' });
      expect(await db.select().from(evaluation)).toHaveLength(0);
      expect(await selection(session.sessionId, { cap: 1 })).toMatchObject({
        done: false,
        answeredCount: 1,
        question: { assessment: { phase: 'pending', pending_run: { run_id: runId } } },
      });
      expect(await db.select().from(assessment_issuance)).toHaveLength(1);
      if (delivery === 'queue unavailable') {
        const report = await reconcileStalledJudgeAttempts(db, {
          now: new Date(Date.now() + RECONCILE_STALL_MS + 1_000),
          deps: {
            ...deps,
            boss: { send, getJobById: vi.fn(async () => null) },
            observe: async (reservation) => ({
              kind: 'absent',
              deliveryId: reservation.delivery_id,
            }),
          },
        });
        expect(report).toMatchObject({ reenqueued: 1, failed: 0 });
        expect(send).toHaveBeenCalledTimes(2);
        expect(deps.checkRateLimit).toHaveBeenCalledTimes(2);
      }
      expect(jobs).toHaveLength(1);
      expect(await db.select().from(event).where(eq(event.id, pending.id))).toEqual([pending]);
      expect(await readJudgeRunPermanent(db, runId)).toMatchObject({
        kind: 'pending',
        delivery: { kind: 'accepted' },
      });
      const execute = vi.fn(
        async (
          request: import('@/core/schema/assessment').ModelExecutorRequest,
          _signal: AbortSignal | undefined,
          taskRunId: string,
        ): Promise<import('@/core/schema/assessment').ModelUnitOutcomeT> => ({
          kind: 'scored',
          points_awarded: request.unit.points,
          matched: {
            rule_id:
              request.unit.criterion.kind === 'rule_reference'
                ? request.unit.criterion.rule_id
                : 'fixture',
            option_ids: [],
          },
          feedback_md: 'offline recorded port',
          confidence: 0.95,
          evidence_citations: [],
          run_refs: [taskRunId],
          cost_usd_micros: 0,
        }),
      );
      vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(
        (_database, _signal, _admission, execution) =>
          createRecordedModelExecutor(
            db,
            execute,
            execution
              ? { fence: (tx, request) => fenceJudgeUnitClaim(tx, execution, request) }
              : {},
          ),
      );
      const job = jobs[0];
      const meta = { retryCount: 0, retryLimit: 2, deliveryId: job.operational.delivery_id };
      expect(await runJudgeRun(db, job, meta)).toMatchObject({ status: 'done', run_id: runId });
      expect(await selection(session.sessionId, { cap: 1 })).toMatchObject({
        done: true,
        reason: 'cap',
        answeredCount: 1,
      });
      const effects = {
        mastery: await db.select().from(mastery_state),
        fsrs: await db.select().from(material_fsrs_state),
      };
      expect(await runJudgeRun(db, job, meta)).toMatchObject({ status: 'skipped' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await db.select().from(evaluation)).toHaveLength(1);
      expect(await db.select().from(evaluation_effective_head)).toHaveLength(1);
      expect(await db.select().from(assessment_submission)).toHaveLength(1);
      expect(
        await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
      ).toHaveLength(1);
      expect(
        await db.select().from(event).where(eq(event.action, 'experimental:assessment_settlement')),
      ).toHaveLength(1);
      expect(await db.select().from(mastery_state)).toEqual(effects.mastery);
      expect(await db.select().from(material_fsrs_state)).toEqual(effects.fsrs);
      expect(await db.select().from(assessment_issuance)).toHaveLength(1);
      expect(await readJudgeRunPermanent(db, runId)).toMatchObject({
        kind: 'resolved',
        activity: 'terminal',
      });
      expect(
        (await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'kc1')))[0]
          .evidence_count,
      ).toBe(1);
    },
  );

  it('rejects unpublished/unadmitted pool items, then resolves a composite root and only its issued part', async () => {
    await seed('unpublished', false);
    const empty = PlacementSessionCreatedSchema.parse(
      await (await start(request({ knowledgeIds: ['kc1'] }))).json(),
    );
    expect(empty.question).toBeNull();
    await seed('withheld');
    await db
      .update(question_group_lifecycle)
      .set({
        scoring_admission_state: 'withheld',
        scoring_admission_withheld_reason: 'owner_hold',
        scoring_admission_evidence: null,
      })
      .where(eq(question_group_lifecycle.group_id, 'withheld'));
    const now = new Date();
    const base = {
      kind: 'choice',
      choices_md: ['左侧', '右侧'],
      reference_md: 'B',
      knowledge_ids: ['kc1'],
      difficulty: 3,
      source: 'manual',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
      version: 0,
    };
    await db
      .insert(question)
      .values({ ...base, id: 'root', knowledge_ids: [], prompt_md: '共享题干' });
    await db.insert(question).values([
      { ...base, id: 'part1', parent_question_id: 'root', part_index: 1, prompt_md: '第一小题' },
      { ...base, id: 'part2', parent_question_id: 'root', part_index: 2, prompt_md: '第二小题' },
    ]);
    const [root] = await db.select().from(question).where(eq(question.id, 'root'));
    const parts = await db.select().from(question).where(eq(question.parent_question_id, 'root'));
    const published = await publishQuestionGroup(db, {
      group_id: 'root',
      contract: normalizeQuestionGroupToContract(root, parts),
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      actorRef: 'test:composite',
      now,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
      },
    });
    expect(published.status).toBe('published');
    const session = await open();
    expect(session.question.questionId).toBe('part1');
    expect(session.question.assessment.state.issuance?.binding.part_ids).toEqual(['part1']);
    expect(
      session.question.assessment.state.practice_dto?.faces.map((face) => face.part_id),
    ).toEqual(['part1']);
    expect(
      session.question.assessment.state.practice_dto?.response_spec.slots.every(
        (slot) => slot.part_id === 'part1',
      ),
    ).toBe(true);
  });

  it('fences placement session/question/occurrence coordinates on shared attempt requests', async () => {
    await seed();
    const session = await open();
    const second = await open();
    const wrongSession = await submit(
      request({
        question_id: 'q1',
        session_id: second.sessionId,
        rating: 'good',
        auto_rate: true,
        assessment: original(session),
      }),
    );
    expect(wrongSession.status).toBe(409);
    expect(
      (await answer(session, { ...original(session), submission_id: 'invented' })).status,
    ).toBe(409);
    expect(await db.select().from(assessment_submission)).toHaveLength(0);
  });
  it('keeps historical events and native regrades in the same distinct-question count', async () => {
    await seed();
    const session = await open();
    await answer(session);
    await db.insert(event).values({
      id: 'historical_duplicate',
      session_id: session.sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'success',
      payload: {},
      created_at: new Date(),
    });
    await correctPaperFixture(db, `evt_assessment_${session.question.assessment.submission_id}`, 0);
    expect(await selection(session.sessionId, { cap: 1 })).toEqual({
      done: true,
      reason: 'cap',
      answeredCount: 1,
    });
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
  });

  it('holds a stored worker resolution even if its job notification was lost, without model redispatch', async () => {
    await seed();
    await publishPaperModelFixture(db, 'q1');
    const session = await open();
    const jobs: NativeJudgeRunJobData[] = [];
    await dispatchNativeAttempt(
      db,
      'q1',
      original(session, 'original unresolved response'),
      { enabled: true, capture: { session_id: session.sessionId } },
      {
        checkRateLimit: () => 1,
        boss: {
          send: async (_queue, data, options) => {
            const job = z
              .object({
                run_id: z.string(),
                caller: z.literal('native_assessment'),
                submit: NativeJudgePendingSubmitInput,
                operational: JudgeWorkflowInput,
              })
              .parse(data);
            expect(options?.id).toBe(job.operational.delivery_id);
            jobs.push(job);
            return job.operational.delivery_id;
          },
        },
      },
    );
    const execute = vi.fn(
      async (): Promise<import('@/core/schema/assessment').ModelUnitOutcomeT> => ({
        kind: 'pending',
        pending: { reason: 'unjudgeable', detail: 'offline held original' },
        run_refs: [],
        cost_usd_micros: 0,
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
    await executeNativeAttempt(db, jobs[0]);
    const recovered = await selection(session.sessionId, { cap: 1 });
    expect(recovered).toMatchObject({
      done: false,
      answeredCount: 1,
      question: { assessment: { phase: 'held', pending_run: null } },
    });
    await expect(executeNativeAttempt(db, jobs[0])).rejects.toMatchObject({
      code: 'judge_already_completed',
    });
    expect(
      await runJudgeRun(db, jobs[0], {
        retryCount: 1,
        retryLimit: 2,
        deliveryId: jobs[0].operational?.delivery_id,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'already_persisted' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await selection(session.sessionId, { cap: 1 })).toEqual(recovered);
    expect(await db.select().from(mastery_state)).toHaveLength(0);
  });

  it('excludes admitted container-only, suspended and withdrawn groups without a manual fallback', async () => {
    await seed('container');
    await seed('suspended');
    await seed('withdrawn');
    await seed('eligible');
    await db
      .update(question_group_lifecycle)
      .set({ availability: 'container_only' })
      .where(eq(question_group_lifecycle.group_id, 'container'));
    await db
      .update(question_group_lifecycle)
      .set({ suspended: true, suspension_reason: 'verify_hold' })
      .where(eq(question_group_lifecycle.group_id, 'suspended'));
    await db
      .update(question_group_lifecycle)
      .set({ withdrawn: true, withdrawn_at: new Date() })
      .where(eq(question_group_lifecycle.group_id, 'withdrawn'));
    expect((await open()).question.questionId).toBe('eligible');
  });

  it('seeds the parent runtime fixture and runs every question through the real local evaluator', async () => {
    const fixture = await seedPlacementRuntimeFixture(db);
    const created = PlacementSessionCreatedSchema.parse(
      await (await start(request({ goalId: fixture.goalId }))).json(),
    );
    if (!created.question) throw new Error('runtime fixture missing first');
    let current = { ...created, question: created.question };
    for (let count = 1; count <= 8; count++) {
      expect((await answer(current)).status).toBe(201);
      const next = await selection(created.sessionId);
      expect(next.answeredCount).toBe(count);
      if (count === 8) expect(next).toEqual({ done: true, answeredCount: 8, reason: 'cap' });
      else {
        if (next.done || !next.question) throw new Error('runtime fixture stopped early');
        current = { ...current, question: next.question };
      }
    }
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_model_claim')),
    ).toHaveLength(0);
    expect(await db.select().from(assessment_submission)).toHaveLength(8);
  });
});
