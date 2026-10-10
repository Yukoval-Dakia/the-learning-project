import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAttempt } from '@/capabilities/practice/api/submit';
import { practiceCapability } from '@/capabilities/practice/manifest';
import { submitReviewAnswerTool } from '@/capabilities/practice/server/tools/submit-review-answer';
import {
  assessment_submission,
  evaluation,
  event,
  learning_session,
  mastery_state,
  material_fsrs_state,
  tool_call_log,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ToolContext } from '@/kernel/tools/types';
import { buildPiDomainAgentTools } from '@/server/ai/tools/pi-tools';
import { registerTool } from '@/server/ai/tools/registry';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { buildHonoApp } from '../../../../server/app';
import {
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
