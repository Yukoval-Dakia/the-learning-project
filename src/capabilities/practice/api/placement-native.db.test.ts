import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import type { ResponseSetT } from '@/core/schema/assessment';
import {
  assessment_issuance,
  assessment_submission,
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
import { publishPlacementFixture } from '../../../../tests/fixtures/assessment-placement';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { insertLegacyGoal } from '../../../../tests/helpers/legacy-goal';
import type { SaveSubmissionRequest } from '../server/assessment/submit';
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
    expect(await read()).toEqual(await read());
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
});
