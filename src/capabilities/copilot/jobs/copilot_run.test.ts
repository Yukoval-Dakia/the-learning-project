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
import {
  type CopilotExecutionAdapters,
  createCopilotExecutionOwner,
} from '@/capabilities/copilot/server/copilot-execution';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import { event } from '@/db/schema';
import { computeReplay, writeJobEvent } from '@/kernel/job-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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
});
