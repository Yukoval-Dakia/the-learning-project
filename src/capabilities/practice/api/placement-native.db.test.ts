import { eq } from 'drizzle-orm';
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
  goal,
  knowledge,
  learning_session,
  mastery_state,
  material_fsrs_state,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
  question,
} from '@/db/schema';

import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';
import { publishPlacementFixture } from '../../../../tests/fixtures/assessment-placement';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { insertLegacyGoal } from '../../../../tests/helpers/legacy-goal';
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
import { placementStarterIdentity } from '../server/question-supply/placement-starter-identity';
import { readPlacementStarterOutcomes } from '../server/question-supply/placement-starter-outcome-reader';
import { materializePlacementStartersForGoal } from '../server/question-supply/placement-starter-store';
import {
  PlacementQuestionSelectionResponseSchema,
  PlacementSessionCreatedSchema,
} from './placement-contracts';
import { createPlacementQuestionSelection as next } from './placement-next';
import { GET as detail } from './placement-session-detail';
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
  it('preserves an exhausted cold claim and all paid receipts across start and repeated no-question reads', async () => {
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'seed:math:root',
        name: '数学',
        domain: 'math',
        parent_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'cold-kc',
        name: '变化率',
        domain: 'math',
        parent_id: 'seed:math:root',
        created_at: now,
        updated_at: now,
      },
    ]);
    const goalId = 'cold-goal';
    await insertLegacyGoal(db, {
      id: goalId,
      title: '变化率',
      subject_id: 'math',
      scope_knowledge_ids: ['cold-kc'],
      sequence_hint: 0,
      source: 'manual',
      now,
    });
    const [coldGoal] = await db.select().from(goal).where(eq(goal.id, goalId));
    if (!coldGoal) throw new Error('missing cold goal');
    await db.insert(event).values({
      id: 'cold-goal-genesis',
      actor_kind: 'system',
      actor_ref: 'goal-create',
      action: 'experimental:genesis',
      subject_kind: 'goal',
      subject_id: goalId,
      outcome: 'success',
      payload: { row: { ...coldGoal } },
      created_at: now,
    });
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, goalId),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing cold claim');
    await db
      .update(placement_starter_claim)
      .set({
        status: 'exhausted',
        exhausted_at: now,
        pg_boss_job_id: 'cold-job',
        known_cost_micro_usd: 18885,
      })
      .where(eq(placement_starter_claim.id, identity.claimId));
    for (let i = 1; i <= 3; i++) {
      await db.insert(placement_starter_attempt).values({
        id: `cold-attempt-${i}`,
        claim_id: identity.claimId,
        pg_boss_job_id: 'cold-job',
        delivery_no: i,
        fencing_token: `11111111-1111-4111-8111-11111111111${i}`,
        status: 'interrupted',
        provider_task_run_id: `cold-model-${i}`,
        provider_output_hash: `digest-${i}`,
        finished_at: now,
        created_at: now,
        updated_at: now,
      });
      await db.insert(placement_starter_cost_component).values({
        id: `cold-cost-${i}`,
        claim_id: identity.claimId,
        attempt_id: `cold-attempt-${i}`,
        component_kind: 'quiz_gen',
        provider_task_run_id: `cold-model-${i}`,
        cost_micro_usd: i === 3 ? 6885 : 6000,
        created_at: now,
      });
    }
    const ledger = async () => ({
      claims: await db.select().from(placement_starter_claim),
      attempts: await db.select().from(placement_starter_attempt),
      costs: await db.select().from(placement_starter_cost_component),
      links: await db.select().from(placement_starter_attempt_question),
    });
    const before = await ledger();
    const response = await start(request({ goalId }));
    expect(response.status).toBe(200);
    const session = PlacementSessionCreatedSchema.parse(await response.json());
    expect(session).toMatchObject({
      question: null,
      answeredCount: 0,
      sourcingNeeded: true,
      starterSupply: [
        {
          state: 'exhausted',
          next_action: 'review_supply_failure',
          failure_reason: { code: 'unknown' },
        },
      ],
    });
    expect(await ledger()).toEqual(before);
    const events = await db.select().from(event);
    const sessions = await db.select().from(learning_session);
    for (let i = 0; i < 3; i++) {
      const selected = await selection(session.sessionId);
      expect(selected).toMatchObject({
        done: false,
        question: null,
        answeredCount: 0,
        starterSupply: session.starterSupply,
      });
      expect(
        (await (await detail(request({}), { id: session.sessionId })).json()).starterSupply,
      ).toEqual(session.starterSupply);
    }
    expect(await ledger()).toEqual(before);
    expect(await db.select().from(event)).toEqual(events);
    expect(await db.select().from(learning_session)).toEqual(sessions);
    expect(await db.select().from(assessment_issuance)).toHaveLength(0);
  });
  // @invariant data: reads preserve paid obligations and bind outcomes to the current revision and subject
  // @fails-if select the old claim or mutate its ledger on read; the explicit claim and ledger assertions fail
  it('reads exhausted and unknown supply repeatedly without replay or mutation, bound to current session revision and subject', async () => {
    await seed();
    const now = new Date();
    await insertLegacyGoal(db, {
      id: 'bound-goal',
      title: '变化率',
      subject_id: 'math',
      scope_knowledge_ids: ['kc1'],
      sequence_hint: 0,
      source: 'manual',
      source_ref: 'revision-one',
      now,
    });
    const created = await start(request({ goalId: 'bound-goal' }));
    expect(created.status).toBe(200);
    const session = PlacementSessionCreatedSchema.parse(await created.json());
    const math = placementStarterIdentity('revision-one', 'math');
    const otherSubject = placementStarterIdentity('revision-one', 'yuwen');
    for (const [identity, subjectId] of [
      [math, 'math'],
      [otherSubject, 'yuwen'],
    ] as const) {
      await db.insert(placement_starter_claim).values({
        id: identity.claimId,
        fingerprint: identity.fingerprint,
        goal_id: 'bound-goal',
        semantic_goal_revision_id: 'revision-one',
        subject_id: subjectId,
        knowledge_id: identity.knowledgeId,
        demand_id: identity.demandId,
        target_id: identity.targetId,
        status: 'exhausted',
        known_cost_micro_usd: 18885,
        exhausted_at: now,
        created_at: now,
        updated_at: now,
      });
    }
    const snapshot = async () => ({
      claims: await db.select().from(placement_starter_claim),
      attempts: await db.select().from(placement_starter_attempt),
      links: await db.select().from(placement_starter_attempt_question),
      costs: await db.select().from(placement_starter_cost_component),
      events: await db.select().from(event),
      sessions: await db.select().from(learning_session),
      issuances: await db.select().from(assessment_issuance),
    });
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      const selected = await selection(session.sessionId);
      expect(selected).toMatchObject({
        done: false,
        question: session.question,
        sourcingNeeded: false,
        starterSupply: [
          {
            session_id: session.sessionId,
            goal_id: 'bound-goal',
            semantic_goal_revision_id: 'revision-one',
            subject_id: 'math',
            claim_id: math.claimId,
            state: 'exhausted',
            next_action: 'review_supply_failure',
            failure_reason: { code: 'unknown' },
          },
        ],
      });
      const response = await detail(request({}), { id: session.sessionId });
      expect(response.status).toBe(200);
      expect((await response.json()).starterSupply).toEqual(selected.starterSupply);
    }
    expect(await snapshot()).toEqual(before);

    // A semantic revision change must stop exposing the old exhausted claim.
    await db.update(goal).set({ source_ref: 'revision-two' }).where(eq(goal.id, 'bound-goal'));
    const read = () =>
      db.transaction((tx) => readPlacementStarterOutcomes(tx, session.sessionId), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    const beforeAbsent = await snapshot();
    expect(await read()).toMatchObject([
      {
        semantic_goal_revision_id: 'revision-two',
        subject_id: 'math',
        claim_id: null,
        state: 'absent',
      },
    ]);
    expect(await snapshot()).toEqual(beforeAbsent);

    const current = placementStarterIdentity('revision-two', 'math');
    await db.insert(placement_starter_claim).values({
      id: current.claimId,
      fingerprint: current.fingerprint,
      goal_id: 'bound-goal',
      semantic_goal_revision_id: 'revision-two',
      subject_id: 'math',
      knowledge_id: current.knowledgeId,
      demand_id: current.demandId,
      target_id: current.targetId,
      status: 'exhausted',
      known_cost_micro_usd: null,
      last_error_code: 'cost_unknown',
      last_error: 'private provider text',
      exhausted_at: now,
      created_at: now,
      updated_at: now,
    });
    const beforeUnknown = await snapshot();
    expect(await read()).toMatchObject([
      {
        state: 'unknown',
        next_action: 'resolve_unknown_outcome',
        failure_reason: { code: 'cost_unknown' },
      },
    ]);
    expect(await read()).toMatchObject([
      {
        claim_id: current.claimId,
        semantic_goal_revision_id: 'revision-two',
        subject_id: 'math',
        state: 'unknown',
      },
    ]);
    expect(await snapshot()).toEqual(beforeUnknown);
    expect(JSON.stringify(await read())).not.toContain('private provider text');
  });
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
      starterSupply: session.starterSupply,
    });
  });

  // @invariant concurrency: an accepted or send-lost delivery is recovered under the same permanent delivery identity and settles the paid judge exactly once; replay re-executes nothing
  // @fails-if drop the pending authority when send fails, redispatch under a new delivery id, or let a replayed job write a second evaluation/settlement; the reenqueue/send-count, unchanged pending row and count-1 assertions fail
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

  // @invariant concurrency: a persisted worker resolution is terminal authority; a lost job notification or redelivery skips with already_persisted and never redispatches the model
  // @fails-if re-execute the model or overwrite the held resolution on replay; the judge_already_completed rejection, already_persisted skip, stable selection and execute-count-1 assertions fail
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
});
