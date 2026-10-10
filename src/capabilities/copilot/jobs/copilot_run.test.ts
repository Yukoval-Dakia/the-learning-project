// YUK-364 / YUK-575 — durable copilot run handler DB test。
//
// mock stream AI（streamTaskCollectingFn）+ 共享装配器 stub（resolveCopilotRunInputFn）
// + real DB（job_events writeJobEvent / computeReplay）。断言：
//   ① happy path 写 started→reply→done 事件序列 + computeReplay 末态 done；
//   ② 非 transient error（plain Error）→ terminal FAILED(exhausted)+reply+return（不 throw，YUK-575 MF1）；
//   ③ 启动前已有 cancel 事件 → 早停写 failed(cancelled)，不调 AI；
//   ④ run handle = run_id = 传入 checkpoint_id（job_events.business_id）。
//   YUK-575/YUK-832: N2 incremental durable streaming（S3）/ N3+S4 ambient 装配往返 / N5+MF-A budget /
//            MF1/MF2 transient·exhausted 分诊 + 幂等守卫 / S6 static 约束。

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as cancelCopilotRun } from '@/capabilities/copilot/api/cancel-run';
import {
  type CopilotExecutionAdapters,
  createCopilotExecutionOwner,
} from '@/capabilities/copilot/server/copilot-execution';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import {
  hashCopilotDurableInput,
  reserveCopilotDurableAcceptance,
  withCopilotDurableDispatchLock,
} from '@/capabilities/copilot/server/durable-dispatch';
import {
  createCopilotRunView,
  foldCopilotRunFrames,
} from '@/capabilities/copilot/ui/subtask-events';
import { event, learning_session } from '@/db/schema';
import type { PiToolMount } from '@/server/ai/tools/pi-tools';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getRecentCopilotTurns } from '../server/turns';
import {
  type CopilotRunJobData,
  type RunCopilotRunParams,
  runCopilotRun as runCopilotRunActual,
} from './copilot_run';

// YUK-364 (F1) — 读 conversation-历史可见的 copilot_reply domain event（turns.ts 读
// 的就是这族 experimental:copilot_reply）。durable 成功路径必须写它，否则回复对历史
// 不可见、user_ask 成 phantom。
async function copilotReplyEvents(sessionId: string) {
  return testDb()
    .select()
    .from(event)
    .where(and(eq(event.session_id, sessionId), eq(event.action, 'experimental:copilot_reply')));
}

// streamTaskCollectingFn 的 ctx 形（db + piToolMounts + allowedTools + piSkillDocs +
// budgetOverride），让 mock.calls[0] 携带 typed tuple。
type AgentCtx = {
  db: unknown;
  taskRunId?: string;
  parentTaskRunId?: string;
  signal?: AbortSignal;
  lifecycleAbortController?: AbortController;
  allowedTools?: string[];
  budgetOverride?: { maxIterations?: number | 'unbounded'; timeoutMs?: number };
  sdkSession?: { persist: boolean; resume?: string };
  providerSessionDeadlineAt?: number;
  piToolMounts?: PiToolMount[];
  piAgents?: Record<string, { tools?: string[] }>;
  piHooks?: {
    beforeToolCall?: Array<
      (
        call: { id: string; name: string },
        args: Record<string, unknown>,
      ) => Promise<{ block: boolean; reason?: string } | undefined>
    >;
    afterToolCall?: Array<(observation: unknown) => Promise<unknown>>;
  };
  onTaskEvent?: (event: unknown) => void | Promise<void>;
};

// streamTaskCollecting mock — 匹配 (kind, input, ctx, onDelta) => Promise<StreamCollectResult>。
// deltas 若给则在 resolve 前逐个 onDelta（模拟 primary stream 曾产生正文）；handler
// 将每条增量写入 durable DELTA。partial/error 模拟
// graceful-degrade。默认不 emit delta（保既有 [STARTED,REPLY,DONE] 事件序列断言）。
function streamMock(
  text: string,
  opts: {
    taskRunId?: string;
    finishReason?: string;
    deltas?: string[];
    partial?: boolean;
    error?: string;
    terminalText?: string;
  } = {},
) {
  const {
    taskRunId = 'tr_x',
    finishReason = 'end_turn',
    deltas,
    partial,
    error,
    terminalText,
  } = opts;
  return vi.fn(
    async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (t: string) => void) => {
      if (deltas) for (const d of deltas) onDelta(d);
      return {
        text,
        task_run_id: taskRunId,
        finishReason,
        usage: { inputTokens: 0, outputTokens: 0 },
        ...(terminalText !== undefined ? { terminalText } : {}),
        ...(partial ? { partial: true, error } : {}),
      };
    },
  );
}

// 共享装配器 stub — 不打真 DB 的 learner-state / history 机器，返回最小 run input。
// handler 只把它透传给 stream；装配器自身的 exclude-cursor / byte-parity 由
// copilot-run-input.db.test.ts 覆盖。ambient 测用 vi.fn spy 断言参数。
const stubRunInput: NonNullable<RunCopilotRunParams['resolveCopilotRunInputFn']> = async (
  _db,
  params,
) => ({
  surface: params.triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot',
  triggered_by: params.triggeredBy,
  user_message: params.userMessage,
  ...(params.chipKind ? { chip_kind: params.chipKind } : {}),
  proposal_feedback: [],
  conversation_history: [],

  correction_contract: {
    available_prior_turn_ids: [],
    prior_turn_summaries: {},
    required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
  },
  ...(params.ambient ? { ambient_context: params.ambient } : {}),
});

const baseData: CopilotRunJobData = {
  run_id: 'copilot_user_ask_test_run',
  session_id: 'sess_test_run',
  user_message: '帮我讲讲这道题',
  triggered_by: 'chat',
};

async function replay(runId: string) {
  return computeReplay(testDb(), {
    businessTable: COPILOT_RUN_TABLE,
    businessId: runId,
    lastEventId: 0,
  });
}

async function seedCopilotConversation(sessionId: string, sdkSessionId?: string) {
  await testDb()
    .insert(learning_session)
    .values({
      id: sessionId,
      type: 'conversation',
      status: 'active',
      entrypoint: 'copilot',
      ...(sdkSessionId ? { agent_sdk_session_id: sdkSessionId } : {}),
      updated_at: new Date(),
    });
}

function successfulWorkerExecution(taskRunId: string, replyText: string, sdkSessionId?: string) {
  return {
    taskRunId,
    finishReason: 'end_turn',
    ...(sdkSessionId ? { sdkSessionId } : {}),
    finalization: {
      replyText,
      preparedReply: { text: replyText },
      receipt: {
        protocol_version: 2 as const,
        assurance: 'execution_trace_bound' as const,
        root_task_run_id: taskRunId,
        candidate_sha256: createHash('sha256').update(replyText).digest('hex'),
        reply_sha256: createHash('sha256').update(replyText).digest('hex'),
        trace_sha256: createHash('sha256').update(taskRunId).digest('hex'),
        trace_call_count: 0,
        observed_completed_tool_use_ids: [],
        correction: 'normal' as const,
        proposal_disclosure: 'none' as const,

        primary_view: 'absent' as const,
      },
      accepted: true,
    },
    partial: false,

    contextDigest: 'ignored-by-worker',
  };
}

type CopilotRunTestParams = RunCopilotRunParams & {
  streamTaskCollectingFn?: unknown;
  runValidationTaskFn?: unknown;
  buildExaMcpServerFn?: CopilotExecutionAdapters['buildExaMcpServerFn'];
  resolveCopilotSkillDocsFn?: CopilotExecutionAdapters['resolveCopilotSkillDocsFn'];
};

async function runCopilotRun(params: CopilotRunTestParams): ReturnType<typeof runCopilotRunActual> {
  // A dispatched worker job always has a committed input root. Preserve that
  // real admission precondition even when model execution is injected here;
  // otherwise missing roots can falsely pass checkpoint-suppression tests.
  const isChip = params.data.triggered_by === 'chip';
  await params.db
    .insert(event)
    .values({
      id: params.data.run_id,
      session_id: params.data.session_id,
      actor_kind: isChip ? 'system' : 'user',
      actor_ref: isChip ? 'ui:copilot_chip' : 'user:self',
      action: isChip ? 'experimental:copilot_chip_trigger' : 'experimental:copilot_user_ask',
      subject_kind: 'query',
      subject_id: params.data.run_id,
      payload: {
        surface: 'copilot',
        user_message: params.data.user_message,
        session_id: params.data.session_id,
        ...(isChip ? { chip_kind: params.data.chip_kind ?? null } : {}),
      },
      created_at: new Date(),
    })
    .onConflictDoNothing();
  const {
    executeCopilotTurnFn,
    streamTaskCollectingFn,
    runValidationTaskFn,
    buildExaMcpServerFn,
    resolveCopilotSkillDocsFn,
    ...runParams
  } = params;
  const stream = streamTaskCollectingFn as
    | CopilotExecutionAdapters['streamTaskCollectingFn']
    | undefined;
  const owner = createCopilotExecutionOwner({
    ...(stream
      ? {
          streamTaskCollectingFn: async (...args: Parameters<typeof stream>) => {
            const result = await stream(...args);
            return result.partial
              ? result
              : {
                  ...result,
                  terminalText: result.terminalText ?? result.text,
                };
          },
        }
      : {}),
    ...(typeof runValidationTaskFn === 'function'
      ? {
          runAgentTaskFn: runValidationTaskFn as CopilotExecutionAdapters['runAgentTaskFn'],
        }
      : {}),
    ...(buildExaMcpServerFn ? { buildExaMcpServerFn } : {}),
    ...(resolveCopilotSkillDocsFn ? { resolveCopilotSkillDocsFn } : {}),
  });
  return runCopilotRunActual({
    ...runParams,
    executeCopilotTurnFn: executeCopilotTurnFn ?? owner,
  });
}

describe('runCopilotRun', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('persists safe tool and subtask activity in order before the terminal, without private Task prompts', async () => {
    const runId = 'copilot_user_ask_safe_activity_48';
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId },
      resolveCopilotRunInputFn: stubRunInput,
      executeCopilotTurnFn: async (_db, turn, policy) => {
        // Match SDK callbacks that do not await each observer. The worker must
        // drain the serialized public events before publishing its final reply.
        void policy.observe?.({
          kind: 'tool_started',
          toolName: 'Task',
          input: { prompt: 'private cross-subject reasoning', subagent_type: 'copilot-researcher' },
        });
        void policy.observe?.({
          kind: 'tool_started',
          toolName: 'query_mistakes',
          toolUseId: 'tool_read_48',
          input: { subject_id: 'math', limit: 48, filter: { concepts: ['定义域', '退化条件'] } },
        });
        void policy.observe?.({
          kind: 'subtask',
          event: {
            step_kind: 'subtask',
            subtask_id: 'child_evidence',
            label: '正在深入核对证据',
            status: 'running',
          },
        });
        void policy.observe?.({
          kind: 'tool_finished',
          toolName: 'query_mistakes',
          input: { subject_id: 'math', limit: 48 },
          summary: '读取完成：48 条作答，包含三轮延迟复习。',
        });
        void policy.observe?.({
          kind: 'tool_finished',
          toolName: 'Task',
          input: { prompt: 'private cross-subject reasoning' },
          summary: 'private child result',
        });
        void policy.observe?.({
          kind: 'subtask',
          event: {
            step_kind: 'subtask',
            subtask_id: 'child_evidence',
            label: '子任务已完成',
            status: 'completed',
          },
        });
        return successfulWorkerExecution(
          turn.taskRunId,
          '已完成证据核对，保留定义域与退化条件的区分。',
        );
      },
    });
    expect(result.status).toBe('done');
    const events = await replay(runId);
    const steps = events.filter((item) => item.event_type === COPILOT_RUN_EVENTS.STEP);
    expect(steps.map((item) => item.payload.step_kind)).toEqual([
      'tool_started',
      'subtask',
      'tool_finished',
      'subtask',
    ]);
    expect(steps[0]?.payload).toMatchObject({
      tool_use_id: 'tool_read_48',
      tool_name: 'query_mistakes',
      input: { filter: { concepts: ['定义域', '退化条件'] } },
    });
    expect(events.slice(-2).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('YUK-939 — malformed terminal becomes one idempotent nonretry failure', async () => {
    const runId = 'copilot_user_ask_malformed_terminal';
    const sessionId = 'sess_malformed_terminal';
    const run = streamMock('untrusted assistant preamble', { terminalText: ' \n\t ' });
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
    } satisfies CopilotRunTestParams;

    expect(await runCopilotRun(params)).toMatchObject({ status: 'failed' });
    expect((await replay(runId)).map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({
      reply_md: '这次回复没有完成可验证的收口，暂不展示未封存的草稿。请重试。',
      reply_finalization: { assurance: 'execution_trace_bound' },
      durable_failure: { reason: 'exhausted', error: 'root terminal reply rejected' },
    });
    expect(JSON.stringify(replies)).not.toContain('untrusted assistant preamble');

    expect(await runCopilotRun(params)).toMatchObject({ status: 'failed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
  });

  it('YUK-757 — overlapping deliveries atomically claim one paid execution and the loser never terminalizes the live owner', async () => {
    const runId = 'copilot_user_ask_overlapping_execution_claim';
    const sessionId = 'sess_overlapping_execution_claim';
    let releaseAssembly: (() => void) | undefined;
    const bothAtAssembly = new Promise<void>((resolve) => {
      releaseAssembly = resolve;
    });
    let assemblyArrivals = 0;
    const assembleBarrier = vi.fn(async (database, input) => {
      assemblyArrivals += 1;
      if (assemblyArrivals === 2) releaseAssembly?.();
      await bothAtAssembly;
      return stubRunInput(database, input);
    }) as RunCopilotRunParams['resolveCopilotRunInputFn'];

    let releasePaidRun: (() => void) | undefined;
    const paidRunGate = new Promise<void>((resolve) => {
      releasePaidRun = resolve;
    });
    const streamRun = vi.fn(async () => {
      await paidRunGate;
      return {
        text: '已由唯一 owner 核对 36 道跨章节作答、三轮延迟复习和五个未教学探针；没有重复物化题目。',
        task_run_id: 'tr_overlapping_execution_owner',
        finishReason: 'end_turn',
        usage: { inputTokens: 8_200, outputTokens: 1_100 },
      };
    });
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: assembleBarrier,
    } satisfies CopilotRunTestParams;
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    const deliveries = [runCopilotRun(params), runCopilotRun(params)];
    let settledCount = 0;
    for (const delivery of deliveries) {
      void delivery.then(
        () => {
          settledCount += 1;
        },
        () => {
          settledCount += 1;
        },
      );
    }
    await vi.waitFor(() => expect(streamRun).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The contender stays observational: it neither retries paid work nor
    // completes/terminalizes the shared run while its owner is live.
    expect(settledCount).toBe(0);
    expect(streamRun).toHaveBeenCalledTimes(1);
    // The loser did not write an ambiguous reply/FAILED while the owner was live.
    expect(await copilotReplyEvents(sessionId)).toHaveLength(0);
    expect(
      (await replay(runId)).some((item) => item.event_type === COPILOT_RUN_EVENTS.FAILED),
    ).toBe(false);

    releasePaidRun?.();
    const settled = await Promise.allSettled(deliveries);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(0);
    expect(streamRun).toHaveBeenCalledTimes(1);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    expect((await replay(runId)).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);

    // A later pg-boss redelivery observes DONE and remains no-op.
    await expect(runCopilotRun(params)).resolves.toMatchObject({ status: 'done' });
    expect(streamRun).toHaveBeenCalledTimes(1);
  });

  it('YUK-757 — enqueue-failure compensation and execution claim share one lock and block stale paid work', async () => {
    const runId = 'run_enqueue_compensation_between_replay_and_claim';
    const sessionId = 'sess_enqueue_compensation_between_replay_and_claim';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    let releaseAssembly!: () => void;
    let markAssemblyEntered!: () => void;
    const assemblyGate = new Promise<void>((resolve) => {
      releaseAssembly = resolve;
    });
    const assemblyEntered = new Promise<void>((resolve) => {
      markAssemblyEntered = resolve;
    });
    const blockedAssembly = vi.fn(async (database, input) => {
      markAssemblyEntered();
      await assemblyGate;
      return stubRunInput(database, input);
    }) as RunCopilotRunParams['resolveCopilotRunInputFn'];
    const paidRun = streamMock(
      '不应在公开 enqueue_failed 之后执行 48 道作答、六个未教学探针和九道迁移题物化。',
    );
    const worker = runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: paidRun as never,
      resolveCopilotRunInputFn: blockedAssembly,
    });
    await assemblyEntered;

    let releaseCompensation!: () => void;
    let markCompensationLocked!: () => void;
    const compensationGate = new Promise<void>((resolve) => {
      releaseCompensation = resolve;
    });
    const compensationLocked = new Promise<void>((resolve) => {
      markCompensationLocked = resolve;
    });
    const compensation = withCopilotDurableDispatchLock(testDb(), runId, async (tx) => {
      await writeJobEvent(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'enqueue_failed', checkpoint_event_id: runId },
      });
      markCompensationLocked();
      await compensationGate;
    });
    await compensationLocked;

    // The worker has already replayed a non-terminal run. Let it reach claim
    // while compensation is still uncommitted: the shared dispatch lock must
    // keep EXECUTION_STARTED and paid model/tools behind that transaction.
    releaseAssembly();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(paidRun).not.toHaveBeenCalled();
    expect((await replay(runId)).map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
    ]);

    releaseCompensation();
    await compensation;
    await expect(worker).resolves.toEqual({ status: 'failed', error: 'enqueue_failed' });
    expect(paidRun).not.toHaveBeenCalled();
    expect((await replay(runId)).map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
  });

  it('Stop — pure-text long run aborts without leaking an unsealed partial candidate', async () => {
    const sessionId = 'sess_stop_pure_text_cross_subject';
    await seedCopilotConversation(sessionId);
    const accepted = await reserveCopilotDurableAcceptance(testDb(), {
      sessionId,
      userMessage: baseData.user_message,
      inputHash: hashCopilotDurableInput({
        user_message: baseData.user_message,
        triggered_by: baseData.triggered_by,
      }),
      idempotencyKey: 'stop_48_answers_6_probes_3_docs_9_transfers',
      queuedPayload: { session_id: sessionId, triggered_by: 'chat' },
    });
    expect(accepted.outcome).toBe('created');
    const runId = accepted.acceptance.runId;
    const partialReply =
      '已完成 48 条历史回答的三科交叉聚类，并核验 3 份讲义中的定义域、方向与量纲；6 个薄弱点探针已确认 4 个，9 个迁移变式尚未开始物化。';
    const queuedReply = '停止前已排队的第 5 个探针结论，不得越过取消提交。';
    const postCancelReply = '停止提交后到达的第 6 个探针结论，不得发布。';
    const prosePersisted = Promise.withResolvers<void>();
    const queuedProseObserved = Promise.withResolvers<void>();
    const cancellationCommitted = Promise.withResolvers<void>();
    const queuedProseSettled = Promise.withResolvers<void>();
    const run = vi.fn<CopilotExecutionAdapters['streamTaskCollectingFn']>(
      async (_kind, input, ctx, onDelta) => {
        expect(input).toMatchObject({
          evidence_shape: {
            answer_count: 48,
            probe_count: 6,
            source_document_count: 3,
            transfer_variant_count: 9,
          },
        });
        onDelta(partialReply);
        // onDelta is void. Wait for the real observer's transaction to commit;
        // awaiting the callback itself would leave persistence racing Stop.
        await prosePersisted.promise;
        const beforeCancel = await replay(runId);
        expect(
          beforeCancel.filter((item) => item.event_type === COPILOT_RUN_EVENTS.DELTA),
        ).toMatchObject([{ payload: { text: partialReply } }]);
        const provisional = foldCopilotRunFrames(
          createCopilotRunView(),
          beforeCancel.map((item) => ({ ...item, event_id: item.id })),
        );
        expect(provisional.replyText).toBe(partialReply);
        expect(await copilotReplyEvents(sessionId)).toHaveLength(0);

        onDelta(queuedReply);
        await queuedProseObserved.promise;
        // The endpoint owns dispatch -> settlement locking. A direct event
        // insert can race a delta transaction that already read "not cancelled".
        const stop = await cancelCopilotRun(
          new Request(`http://test/api/copilot/runs/${runId}/cancel`, { method: 'POST' }),
          { id: runId },
        );
        cancellationCommitted.resolve();
        expect(stop.status).toBe(200);
        expect(await stop.json()).toEqual({ ok: true, run_id: runId, status: 'cancel_requested' });
        await queuedProseSettled.promise;
        onDelta(postCancelReply);
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) resolve();
          else ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        expect(ctx.signal?.aborted).toBe(true);
        return {
          text: partialReply + queuedReply + postCancelReply,
          task_run_id: 'tr_stop_pure_text_cross_subject',
          finishReason: 'error',
          usage: { inputTokens: 18_400, outputTokens: 1_320 },
          partial: true,
          error: 'root SDK loop aborted after Stop',
        };
      },
    );
    const owner = createCopilotExecutionOwner({ streamTaskCollectingFn: run });
    const richInput = vi.fn(async () => ({
      surface: 'copilot' as const,
      triggered_by: 'chat' as const,
      user_message: baseData.user_message,
      proposal_feedback: [],
      correction_contract: {
        available_prior_turn_ids: [],
        prior_turn_summaries: {},
        required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'] as const,
      },
      conversation_history: Array.from({ length: 48 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `historical answer evidence ${index + 1}`,
      })),
      evidence_shape: {
        answer_count: 48,
        probe_count: 6,
        source_document_count: 3,
        transfer_variant_count: 9,
      },
    }));

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      executeCopilotTurnFn: (db, turn, policy) =>
        owner(db, turn, {
          ...policy,
          observe: async (activity) => {
            if (activity.kind === 'prose_delta' && activity.text === queuedReply) {
              queuedProseObserved.resolve();
              await cancellationCommitted.promise;
            }
            try {
              await policy.observe?.(activity);
            } finally {
              if (activity.kind === 'prose_delta' && activity.text === partialReply)
                prosePersisted.resolve();
              if (activity.kind === 'prose_delta' && activity.text === queuedReply)
                queuedProseSettled.resolve();
            }
          },
        }),
      resolveCopilotRunInputFn: richInput as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(run).toHaveBeenCalledTimes(1);
    const events = await replay(runId);
    expect(events.map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(events.filter((event) => event.event_type === COPILOT_RUN_EVENTS.FAILED)).toHaveLength(
      1,
    );
    expect(events.some((event) => event.event_type === COPILOT_RUN_EVENTS.DONE)).toBe(false);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: 'cancelled',
      reply_md: '已停止这次运行。',
      checkpoint_event_id: runId,
    });
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      outcome: 'failure',
      payload: {
        reply_md: '已停止这次运行。',
        durable_failure: { reason: 'cancelled' },
      },
    });
    const stopped = foldCopilotRunFrames(
      createCopilotRunView(),
      events.map((item) => ({ ...item, event_id: item.id })),
    );
    expect(stopped).toMatchObject({
      phase: 'failed',
      failureReason: 'cancelled',
      replyText: '已停止这次运行。',
      checkpointEventId: runId,
    });
    const turns = await getRecentCopilotTurns(testDb(), { sessionId });
    expect(turns.filter((turn) => turn.role === 'ai')).toMatchObject([
      { text: '已停止这次运行。', checkpoint_event_id: runId },
    ]);
    expect(JSON.stringify(events)).not.toContain(queuedReply);
    expect(JSON.stringify(events)).not.toContain(postCancelReply);
    const durableTerminal = JSON.stringify({
      events: events.filter((item) => item.event_type !== COPILOT_RUN_EVENTS.DELTA),
      replies,
      turns,
    });
    for (const candidate of [partialReply, queuedReply, postCancelReply])
      expect(durableTerminal).not.toContain(candidate);
  });
});
