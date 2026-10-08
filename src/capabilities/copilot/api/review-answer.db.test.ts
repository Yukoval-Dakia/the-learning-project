import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAttempt } from '@/capabilities/practice/api/submit';
import { practiceCapability } from '@/capabilities/practice/manifest';
import { recordAssistanceExposure } from '@/capabilities/practice/server/assessment/assistance';
import { submitReviewAnswerTool } from '@/capabilities/practice/server/tools/submit-review-answer';
import { canonicalHash } from '@/core/migration/canonical';
import {
  assessment_submission,
  evaluation,
  event,
  job_events,
  learning_session,
  mastery_state,
  material_fsrs_state,
  tool_call_log,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  BoundReviewAnswerSchema,
  ReviewAnswerAttachmentSchema,
} from '@/kernel/tools/review-answer';
import type { ToolContext } from '@/kernel/tools/types';
import { buildPiDomainAgentTools } from '@/server/ai/tools/pi-tools';
import { registerTool } from '@/server/ai/tools/registry';
import { writeJobEvent } from '@/server/events/writer';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { buildHonoApp } from '../../../../server/app';
import {
  handwritingFixture,
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { copilotCapability } from '../manifest';
import {
  type CopilotExecutionAdapters,
  createCopilotExecutionOwner,
} from '../server/copilot-execution';
import { createCopilotRunCancellationControl } from '../server/copilot-run-cancellation';
import type { CopilotRunInput } from '../server/copilot-run-input';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { selectAsksWithMaterializingToolCall } from '../server/materializing-tools';
import { resolveCopilotReviewAnswer } from '../server/review-answer-consumer';

const boss = vi.hoisted(() => ({
  send: vi.fn(async () => 'offline-job'),
  getJobById: vi.fn(async () => null),
}));
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: async () => boss,
  fromPgBossDrizzleTx: () => ({}),
}));
// Only queue delivery is substituted. Real route/session/acceptance/original/effect owners run.
vi.mock('@/server/runtime-env', () => ({ shouldEnqueueBackgroundJobs: () => true }));
registerTool(submitReviewAnswerTool);
const app = buildHonoApp([copilotCapability, practiceCapability], {
  epochGate: async () => ({ runnable: true }),
});
const token = 'offline-yuk1356-token';
const input: CopilotRunInput = {
  surface: 'copilot',
  triggered_by: 'chat',
  user_message: '核对附上的原件。',
  proposal_feedback: [],
  conversation_history: [],
  correction_contract: {
    available_prior_turn_ids: [],
    prior_turn_summaries: {},
    required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
  },
};

beforeEach(async () => {
  await resetDb();
  await testDb().execute(sql`TRUNCATE job_events RESTART IDENTITY`);
  __resetRateLimitForTests();
  boss.send.mockClear();
  vi.stubEnv('INTERNAL_TOKEN', token);
  vi.stubEnv('JUDGE_DURABLE_ENABLED', 'false');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function post(body: unknown, key = 'review-chat-key', authenticated = true) {
  return app.request('/api/copilot/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': key,
      ...(authenticated ? { 'x-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function accepted(
  extra: Record<string, unknown> = {},
  fixture?: Awaited<ReturnType<typeof nativeSoloHttpFixture>>,
) {
  const f = fixture ?? (await nativeSoloHttpFixture(testDb()));
  const request = {
    triggered_by: 'chat',
    user_message: input.user_message,
    review_answer: {
      authorize_submission: true,
      question_id: f.id,
      assessment: f.assessment,
      reasoning_trace: '固定水量，逐次改变坡度；保留假设、反例及不确定项。'.repeat(70),
    },
    ...extra,
  };
  const response = await post(request);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
  const receipt = await response.json();
  if (typeof receipt.run_id !== 'string' || typeof receipt.session_id !== 'string')
    throw new Error('missing receipt');
  const runId: string = receipt.run_id;
  const sessionId: string = receipt.session_id;
  return { f, request, runId, sessionId };
}
async function context(
  runId: string,
  sessionId: string,
  controller = new AbortController(),
): Promise<ToolContext> {
  return {
    db: testDb(),
    sessionId,
    taskRunId: 'offline-domain-task',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
    causedByEventId: runId,
    signal: controller.signal,
    reviewAnswer: await resolveCopilotReviewAnswer(testDb(), {
      sourceEventId: runId,
      sessionId,
      signal: controller.signal,
    }),
  };
}
async function counts() {
  return {
    submissions: await testDb().select().from(assessment_submission),
    fsrs: await testDb().select().from(material_fsrs_state),
    mastery: await testDb().select().from(mastery_state),
    activations: await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_activation')),
  };
}

it('authenticated chat → real execution owner → Pi AgentTool → shared review commit; replay has one effect', async () => {
  const a = await accepted();
  expect((await counts()).submissions).toHaveLength(1);
  expect((await counts()).activations).toHaveLength(0);
  expect(await selectAsksWithMaterializingToolCall(testDb(), [a.runId])).toEqual(
    new Set([a.runId]),
  );
  let wireInput: unknown;
  let toolOutput: unknown;
  const stream: CopilotExecutionAdapters['streamTaskCollectingFn'] = async (
    _kind,
    modelInput,
    ctx,
  ) => {
    wireInput = modelInput;
    const mount = ctx.piToolMounts?.find((m) => m.type === 'domain');
    if (mount?.type !== 'domain') throw new Error('no actual domain mount');
    const [tool] = buildPiDomainAgentTools({
      ...mount.options,
      toolNames: ['submit_review_answer'],
    });
    toolOutput = await tool.execute('offline-pi-call', { original_ref: a.runId });
    return {
      task_run_id: 'offline-root-task',
      text: '原件已受理。',
      terminalText: '原件已受理。',
      partial: false,
    };
  };
  const execute = createCopilotExecutionOwner({
    streamTaskCollectingFn: stream,
    runAgentTaskFn: async () => {
      throw new Error('unexpected secondary model');
    },
    buildExaMcpServerFn: () => null,
    resolveCopilotSkillDocsFn: async () => undefined,
  });
  const cancellation = createCopilotRunCancellationControl({ db: testDb(), runId: a.runId });
  await execute(
    testDb(),
    { input, sessionId: a.sessionId, sourceEventId: a.runId, taskRunId: 'offline-root-task' },
    { cancellation, deadlineAt: Date.now() + 60000, subagentsEnabled: false },
  );
  cancellation.dispose();
  expect(JSON.stringify(wireInput)).toContain(a.runId);
  expect(JSON.stringify(wireInput)).not.toContain('authorize_submission');
  expect(JSON.stringify(toolOutput)).toContain('committed');
  expect(
    await testDb()
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.tool_name, 'submit_review_answer')),
  ).toHaveLength(1);
  const before = await counts();
  expect(before.submissions).toHaveLength(1);
  expect(before.fsrs).toHaveLength(0);
  expect(before.activations).toHaveLength(1);
  expect(before.mastery).toHaveLength(0);
  expect(before.submissions[0].response_set).toEqual(a.f.assessment.response_set);
  const [candidate] = await testDb().select().from(evaluation);
  expect(candidate.provenance).toMatchObject({ assisted: true });
  const replay = await post(a.request);
  expect(await replay.json()).toMatchObject({ run_id: a.runId, session_id: a.sessionId });
  await submitReviewAnswerTool.execute(await context(a.runId, a.sessionId), {
    original_ref: a.runId,
  });
  const http = await createAttempt(nativeHttpRequest(a.f.body()));
  expect(http.status).toBe(200);
  expect(await counts()).toEqual(before);
  expect(a.f.execute).not.toHaveBeenCalled();
});

it('keeps prior assistance and never accepts a model-authored replacement or identity flags', async () => {
  const f = await nativeSoloHttpFixture(testDb());
  const helpId = await recordAssistanceExposure(testDb(), {
    issuanceId: f.assessment.issuance_id,
    questionId: f.id,
    kind: 'hint',
    impact: 'answer_help',
    contentDigest: 'existing-hint',
  });
  const a = await accepted({}, f);
  const ctx = await context(a.runId, a.sessionId);
  const modelAuthored = {
    original_ref: a.runId,
    response_md: 'agent answer',
    actor_kind: 'user',
    independent: true,
  };
  await expect(submitReviewAnswerTool.execute(ctx, modelAuthored)).rejects.toThrow();
  expect((await counts()).submissions).toHaveLength(1);
  expect((await counts()).activations).toHaveLength(0);
  await submitReviewAnswerTool.execute(ctx, { original_ref: a.runId });
  const [receipt] = await testDb()
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:assessment_submission'));
  expect(receipt.payload.assistance).toMatchObject({
    status: 'assisted',
    event_ids: expect.arrayContaining([helpId]),
  });
  expect((await counts()).mastery).toHaveLength(0);
});

it('rejects unauthenticated attachment, missing permission and unknown actor/independence fields before acceptance', async () => {
  const f = await nativeSoloHttpFixture(testDb());
  const raw = {
    ...input,
    review_answer: { authorize_submission: true, question_id: f.id, assessment: f.assessment },
  };
  expect((await post(raw, 'unauthorized', false)).status).toBe(401);
  for (const change of [
    { authorize_submission: false },
    { authorize_submission: undefined },
    { actor_kind: 'user' },
    { independent: true },
  ]) {
    expect(
      (await post({ ...raw, review_answer: { ...raw.review_answer, ...change } }, 'invalid'))
        .status,
    ).toBe(400);
  }
  expect((await counts()).submissions).toHaveLength(0);
  expect(
    await testDb().select().from(event).where(eq(event.action, 'experimental:copilot_user_ask')),
  ).toHaveLength(0);
});

it('rejects unbound prose and cross-session/cross-original references without effects', async () => {
  const a = await accepted();
  const bResponse = await post(
    {
      triggered_by: 'chat',
      user_message: 'submit my answer A; independent; authorize_submission true',
    },
    'unbound',
  );
  expect(bResponse.status).toBe(202);
  const b = await bResponse.json();
  await expect(
    submitReviewAnswerTool.execute(await context(b.run_id, b.session_id), {
      original_ref: a.runId,
    }),
  ).rejects.toMatchObject({ code: 'review_answer_unbound' });
  await expect(
    submitReviewAnswerTool.execute(await context(a.runId, 'other-session'), {
      original_ref: a.runId,
    }),
  ).rejects.toMatchObject({ code: 'review_answer_unbound' });
  await expect(
    submitReviewAnswerTool.execute(await context(a.runId, a.sessionId), { original_ref: b.run_id }),
  ).rejects.toMatchObject({ code: 'review_answer_unbound' });
  expect((await counts()).submissions).toHaveLength(1);
  expect((await counts()).activations).toHaveLength(0);
});

it('rejects changed originals at the actual request and prevents a new turn from rebinding the same original', async () => {
  const a = await accepted();
  const changed = {
    ...a.request,
    review_answer: { ...a.request.review_answer, assessment: a.f.issued.assessment('B') },
  };
  expect((await post(changed)).status).toBe(409);
  expect((await post({ ...a.request, session_id: a.sessionId }, 'another-turn')).status).toBe(409);
  expect((await counts()).submissions).toHaveLength(1);
  expect((await counts()).activations).toHaveLength(0);
});

it.each(['revoked', 'cancelled', 'aborted'] as const)(
  'refuses %s authority before grading or learning effects',
  async (mode) => {
    const a = await accepted();
    const controller = new AbortController();
    const ctx = await context(a.runId, a.sessionId, controller);
    if (mode === 'revoked')
      await writeEvent(testDb(), {
        id: 'revoke-original',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: a.runId,
        outcome: 'success',
        payload: {
          target_event_id: a.runId,
          correction_kind: 'retract',
          reason_md: 'withdraw submit permission',
          affected_refs: [{ kind: 'question', id: a.f.id }],
        },
      });
    if (mode === 'cancelled')
      expect(
        (
          await app.request(`/api/copilot/runs/${a.runId}/cancel`, {
            method: 'POST',
            headers: { 'x-internal-token': token },
          })
        ).status,
      ).toBe(200);
    if (mode === 'aborted') controller.abort();
    await expect(submitReviewAnswerTool.execute(ctx, { original_ref: a.runId })).rejects.toThrow();
    expect((await counts()).submissions).toHaveLength(1);
    expect((await counts()).activations).toHaveLength(0);
    expect(await testDb().select().from(evaluation)).toHaveLength(0);
    expect((await counts()).fsrs).toHaveLength(0);
  },
);

it('keeps the submitted original immutable and rejects a modified stored binding', async () => {
  const a = await accepted();
  const ctx = await context(a.runId, a.sessionId);
  const [ask] = await testDb().select().from(event).where(eq(event.id, a.runId));
  const binding = BoundReviewAnswerSchema.parse(ask.payload.review_answer);
  expect(binding.original_sha256).toBe(
    canonicalHash(ReviewAnswerAttachmentSchema.parse(a.request.review_answer)),
  );
  expect(JSON.stringify(binding)).not.toContain('response_set');
  await expect(
    testDb()
      .update(assessment_submission)
      .set({ response_set: a.f.issued.assessment('B').response_set })
      .where(eq(assessment_submission.submission_id, binding.submission_id)),
  ).rejects.toThrow();
  await testDb()
    .update(event)
    .set({
      payload: { ...ask.payload, review_answer: { ...binding, original_sha256: '0'.repeat(64) } },
    })
    .where(eq(event.id, a.runId));
  await expect(
    submitReviewAnswerTool.execute(ctx, { original_ref: a.runId }),
  ).rejects.toMatchObject({ code: 'review_original_modified' });
  expect((await counts()).submissions).toHaveLength(1);
  expect((await counts()).activations).toHaveLength(0);
});

it('refuses another question/issuance and a closed review session at the authenticated consumer', async () => {
  const f = await nativeSoloHttpFixture(testDb());
  await testDb()
    .insert(learning_session)
    .values({ id: 'closed-review', type: 'review', status: 'completed' });
  for (const fields of [
    { question_id: 'other-question' },
    { review_session_id: 'closed-review' },
  ]) {
    const response = await post(
      {
        triggered_by: 'chat',
        user_message: input.user_message,
        review_answer: {
          authorize_submission: true,
          question_id: f.id,
          assessment: f.assessment,
          ...fields,
        },
      },
      'bad-coordinates',
    );
    expect(response.status).toBe(409);
  }
  expect((await counts()).submissions).toHaveLength(0);
});

it('uses the existing pg-boss native dispatch and worker commit for a bound model original', async () => {
  const f = await nativeSoloHttpFixture(testDb(), { model: true });
  const started = await app.request('/api/review-sessions', {
    method: 'POST',
    headers: { 'x-internal-token': token, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(started.status).toBe(201);
  const session = await started.json();
  vi.stubEnv('JUDGE_DURABLE_ENABLED', 'true');
  const image = await handwritingFixture(testDb());
  const a = await accepted(
    {
      review_answer: {
        authorize_submission: true,
        question_id: f.id,
        assessment: { ...f.assessment, group_evidence: [image] },
        review_session_id: session.session_id,
        reasoning_trace: '区分水量、坡度、流速，并保留不确定的解释。'.repeat(80),
      },
    },
    f,
  );
  const ctx = await context(a.runId, a.sessionId);
  const pending = await submitReviewAnswerTool.execute(ctx, { original_ref: a.runId });
  expect(pending.kind).toBe('pending');
  expect(f.execute).not.toHaveBeenCalled();
  if (pending.kind !== 'pending') throw new Error('expected native pending receipt');
  const { JudgePendingAttemptPayload } = await import('@/core/schema/event/judge-pending-events');
  const { executeNativeAttempt } = await import(
    '@/capabilities/practice/server/assessment/durable-attempt'
  );
  const [original] = await testDb()
    .select()
    .from(event)
    .where(eq(event.id, `evt_pending_${pending.run_id}`));
  const payload = JudgePendingAttemptPayload.parse(original.payload);
  if (payload.caller !== 'native_assessment') throw new Error('expected native original');
  const job = { run_id: pending.run_id, caller: payload.caller, submit: payload.submit };
  expect(await submitReviewAnswerTool.execute(ctx, { original_ref: a.runId })).toEqual(pending);
  const sent = boss.send.mock.calls.length;
  await executeNativeAttempt(testDb(), job);
  const before = await counts();
  expect(before.submissions).toHaveLength(1);
  expect(before.activations).toHaveLength(1);
  expect(before.mastery).toHaveLength(0);
  await executeNativeAttempt(testDb(), job);
  expect(await counts()).toEqual(before);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(boss.send).toHaveBeenCalledTimes(sent);
});

it('grades an original captured by the existing authenticated submissions owner and applies learning once', async () => {
  const f = await nativeSoloHttpFixture(testDb());
  const capture = await app.request('/api/submissions', {
    method: 'POST',
    headers: { 'x-internal-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(f.assessment),
  });
  expect(capture.status).toBe(201);
  expect((await counts()).activations).toHaveLength(0);
  const a = await accepted({}, f);
  const ctx = await context(a.runId, a.sessionId);
  const result = await submitReviewAnswerTool.execute(ctx, { original_ref: a.runId });
  expect(result).toMatchObject({ kind: 'committed', status: 'effective' });
  const before = await counts();
  expect(before.submissions).toHaveLength(1);
  expect(before.fsrs).toHaveLength(1);
  expect(before.mastery).toHaveLength(1);
  expect(before.activations).toHaveLength(1);
  const [candidate] = await testDb().select().from(evaluation);
  expect(candidate.provenance).toMatchObject({ source: 'automatic', assisted: false });
  await submitReviewAnswerTool.execute(ctx, { original_ref: a.runId });
  expect((await createAttempt(nativeHttpRequest(f.body()))).status).toBe(200);
  expect(await counts()).toEqual(before);
  expect(f.execute).not.toHaveBeenCalled();
});

it.each([
  'expired',
  'forged-binding',
  'missing-acceptance',
  'settled',
  'ended-conversation',
] as const)(
  'fails closed on %s capability, even when the model knows the original reference',
  async (mode) => {
    const a = await accepted();
    const [ask] = await testDb().select().from(event).where(eq(event.id, a.runId));
    const binding = BoundReviewAnswerSchema.parse(ask.payload.review_answer);
    const queued = and(
      eq(job_events.business_table, COPILOT_RUN_TABLE),
      eq(job_events.business_id, a.runId),
      eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
    );
    if (mode === 'expired' || mode === 'forged-binding') {
      const modified = {
        ...binding,
        expires_at: mode === 'expired' ? '2020-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
      };
      await testDb()
        .update(event)
        .set({ payload: { ...ask.payload, review_answer: modified } })
        .where(eq(event.id, a.runId));
      if (mode === 'expired') {
        // A previously minted, intact capability whose deadline has elapsed.
        const [marker] = await testDb().select().from(job_events).where(queued);
        await testDb()
          .update(job_events)
          .set({
            payload: { ...marker.payload, review_answer_binding_sha256: canonicalHash(modified) },
          })
          .where(queued);
      }
    }
    if (mode === 'missing-acceptance') await testDb().delete(job_events).where(queued);
    if (mode === 'settled')
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: a.runId,
        event_type: COPILOT_RUN_EVENTS.DONE,
        payload: {},
      });
    if (mode === 'ended-conversation')
      await testDb()
        .update(learning_session)
        .set({ status: 'ended' })
        .where(eq(learning_session.id, a.sessionId));
    const ctx = await context(a.runId, a.sessionId);
    await expect(submitReviewAnswerTool.execute(ctx, { original_ref: a.runId })).rejects.toThrow();
    expect((await counts()).activations).toHaveLength(0);
    expect((await counts()).mastery).toHaveLength(0);
    expect((await counts()).fsrs).toHaveLength(0);
    expect(await testDb().select().from(evaluation)).toHaveLength(0);
  },
);

it.each(['cancelled', 'revoked', 'closed-review'] as const)(
  'rechecks %s permission after grading before the original can activate learning',
  async (mode) => {
    const f = await nativeSoloHttpFixture(testDb(), { model: true });
    const reviewId = 'review-after-grading';
    await testDb()
      .insert(learning_session)
      .values({ id: reviewId, type: 'review', status: 'started' });
    const a = await accepted(
      {
        review_answer: {
          authorize_submission: true,
          question_id: f.id,
          assessment: f.assessment,
          review_session_id: reviewId,
        },
      },
      f,
    );
    const ctx = await context(a.runId, a.sessionId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realExecutor = f.execute.getMockImplementation();
    if (!realExecutor) throw new Error('missing offline recorded executor');
    f.execute.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return realExecutor(...args);
    });
    const running = submitReviewAnswerTool.execute(ctx, { original_ref: a.runId });
    const rejected = expect(running).rejects.toThrow();
    try {
      await entered.promise;
      if (mode === 'cancelled')
        expect(
          (
            await app.request(`/api/copilot/runs/${a.runId}/cancel`, {
              method: 'POST',
              headers: { 'x-internal-token': token },
            })
          ).status,
        ).toBe(200);
      if (mode === 'revoked')
        await writeEvent(testDb(), {
          id: 'revoke-during-grading',
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: a.runId,
          outcome: 'success',
          payload: {
            target_event_id: a.runId,
            correction_kind: 'retract',
            reason_md: 'withdraw permission',
            affected_refs: [{ kind: 'question', id: f.id }],
          },
        });
      if (mode === 'closed-review')
        await testDb()
          .update(learning_session)
          .set({ status: 'completed' })
          .where(eq(learning_session.id, reviewId));
    } finally {
      release.resolve();
    }
    await rejected;
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await counts()).submissions).toHaveLength(1);
    expect((await counts()).activations).toHaveLength(0);
    expect((await counts()).mastery).toHaveLength(0);
    expect((await counts()).fsrs).toHaveLength(0);
  },
);
