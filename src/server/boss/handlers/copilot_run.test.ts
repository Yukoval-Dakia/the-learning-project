// YUK-364 / YUK-575 — durable copilot run handler DB test。
//
// mock stream AI（streamTaskCollectingFn）+ 共享装配器 stub（resolveCopilotRunInputFn）
// + real DB（job_events writeJobEvent / computeReplay）。断言：
//   ① happy path 写 started→reply→done 事件序列 + computeReplay 末态 done；
//   ② 非 transient error（plain Error）→ terminal FAILED(exhausted)+reply+return（不 throw，YUK-575 MF1）；
//   ③ 启动前已有 cancel 事件 → 早停写 failed(cancelled)，不调 AI；
//   ④ run handle = run_id = 传入 checkpoint_id（job_events.business_id）。
//   YUK-575: N2 流式 delta FIFO（S3）/ N3+S4 ambient 装配往返 / N5+MF-A budget /
//            MF1/MF2 transient·exhausted 分诊 + 幂等守卫 / S6 static 约束。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { writeCopilotReply } from '@/capabilities/copilot/server/chat';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  deriveCopilotRunStatus,
} from '@/capabilities/copilot/server/copilot-run-status';
import { countOutstandingDurableRuns } from '@/capabilities/copilot/server/durable-backlog';
import { withCopilotDurableDispatchLock } from '@/capabilities/copilot/server/durable-dispatch';
import { COPILOT_SUBAGENT_NAME } from '@/capabilities/copilot/server/subagents';
import { event, job_events } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/server/ai/tools/allowlists';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { and, eq } from 'drizzle-orm';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { STUCK_RUN_THRESHOLD_MS } from './ai_task_run_reconcile';
import {
  type CopilotRunJobData,
  DURABLE_BUDGET,
  type RunCopilotRunParams,
  buildCopilotRunHandler,
  claimCopilotExecutionFence,
  hasCopilotSettlementTerminal,
  runCopilotRun,
  writeFailedTerminalProjection,
  writeSuccessfulTerminalProjection,
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

// streamTaskCollectingFn 的 ctx 形（db + mcpServers + allowedTools + skills +
// budgetOverride），让 mock.calls[0] 携带 typed tuple。
type AgentCtx = {
  db: unknown;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  skills?: string[];
  budgetOverride?: { maxIterations?: number; timeoutMs?: number };
  agents?: Record<string, { tools?: string[] }>;
  hooks?: Record<string, unknown>;
  canUseTool?: (...args: unknown[]) => unknown;
  onTaskEvent?: (event: unknown) => void | Promise<void>;
};

// streamTaskCollecting mock — 匹配 (kind, input, ctx, onDelta) => Promise<StreamCollectResult>。
// deltas 若给则在 resolve 前逐个 onDelta（测 N2/S3 FIFO）；partial/error 模拟
// graceful-degrade。默认不 emit delta（保既有 [STARTED,REPLY,DONE] 事件序列断言）。
function streamMock(
  text: string,
  opts: {
    taskRunId?: string;
    finishReason?: string;
    deltas?: string[];
    partial?: boolean;
    error?: string;
  } = {},
) {
  const { taskRunId = 'tr_x', finishReason = 'end_turn', deltas, partial, error } = opts;
  return vi.fn(
    async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (t: string) => void) => {
      if (deltas) for (const d of deltas) onDelta(d);
      return {
        text,
        task_run_id: taskRunId,
        finishReason,
        usage: { inputTokens: 0, outputTokens: 0 },
        ...(partial ? { partial: true, error } : {}),
      };
    },
  );
}

// 共享装配器 stub — 不打真 DB 的 learner-state / history 机器，返回最小 run input。
// handler 只把它透传给 stream；装配器自身的 exclude-cursor / byte-parity 由
// copilot-run-input.db.test.ts 覆盖。ambient 测用 vi.fn spy 断言参数。
const stubRunInput: RunCopilotRunParams['resolveCopilotRunInputFn'] = async (_db, params) => ({
  surface: params.triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot',
  triggered_by: params.triggeredBy,
  user_message: params.userMessage,
  ...(params.chipKind ? { chip_kind: params.chipKind } : {}),
  proposal_feedback: [],
  conversation_history: [],
  ...(params.ambient ? { ambient_context: params.ambient } : {}),
});

// 假 MCP server seam（生产进程在 handler 注册前已完成 manifest tool 装配；测试隔离用
// 一个无害占位，handler 只把它装进 mcpServers map 不解引用）。
function mcpMock() {
  return vi.fn(() => ({ type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME }) as never);
}

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

describe('runCopilotRun', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('① happy path — 写 started→reply→done 序列，computeReplay 末态 done', async () => {
    const run = streamMock('这是回答');
    const result = await runCopilotRun({
      db: testDb(),
      data: baseData,
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({ status: 'done', reply: '这是回答', task_run_id: 'tr_x' });

    const events = await replay(baseData.run_id);
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    const replyEvent = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    expect(replyEvent?.payload).toMatchObject({ reply_md: '这是回答', task_run_id: 'tr_x' });
    expect(deriveCopilotRunStatus(events)).toBe('done');

    // YUK-364 (F1) — 成功路径同时写 conversation-历史可见的 copilot_reply domain event。
    const replies = await copilotReplyEvents(baseData.session_id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      session_id: baseData.session_id,
      action: 'experimental:copilot_reply',
      caused_by_event_id: baseData.run_id,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
    });
    expect(replies[0]?.payload).toMatchObject({ reply_md: '这是回答', task_run_id: 'tr_x' });
  });

  it('YUK-757 — durable run mounts the same depth-1 researcher and persists interleaved safe subtask steps in order', async () => {
    const runId = 'copilot_user_ask_subtask_lifecycle';
    const run = vi.fn(
      async (_kind: string, _input: unknown, ctx: AgentCtx, onDelta: (text: string) => void) => {
        await ctx.onTaskEvent?.({
          type: 'system',
          subtype: 'task_started',
          task_id: 'durable-local-workflow-hidden',
          description: 'DO NOT LEAK hidden durable local workflow',
          subagent_type: COPILOT_SUBAGENT_NAME,
          task_type: 'local_workflow',
          workflow_name: 'spec',
          skip_transcript: true,
          uuid: '00000000-0000-4000-8000-000000000030',
          session_id: 'sdk-durable-session',
        });
        await ctx.onTaskEvent?.({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-cross-artifacts-77',
          tool_use_id: 'toolu-cross-artifacts-77',
          description: '交叉核对函数讲义、四次历史作答与知识图谱先修边',
          subagent_type: COPILOT_SUBAGENT_NAME,
          prompt: 'DO NOT LEAK durable raw learner text or hidden reasoning',
          uuid: '00000000-0000-4000-8000-000000000031',
          session_id: 'sdk-durable-session',
        });
        onDelta('我先核对证据，再给你一个统一解释。');
        await ctx.onTaskEvent?.({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-question-preview-31',
          tool_use_id: 'toolu-question-preview-31',
          description: '预览参数函数辨析题，覆盖 a=0 与判别式为零两种退化情形',
          subagent_type: COPILOT_SUBAGENT_NAME,
          prompt: 'DO NOT LEAK private chain of thought',
          uuid: '00000000-0000-4000-8000-000000000032',
          session_id: 'sdk-durable-session',
        });
        await ctx.onTaskEvent?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-cross-artifacts-77',
          tool_use_id: 'toolu-cross-artifacts-77',
          status: 'completed',
          output_file: '/private/tmp/never-expose.txt',
          summary: 'DO NOT LEAK subagent transcript',
          usage: { total_tokens: 3010, tool_uses: 9, duration_ms: 28_500 },
          uuid: '00000000-0000-4000-8000-000000000033',
          session_id: 'sdk-durable-session',
        });
        onDelta('结论：你把“导数为零”误当成了“导数必变号”。');
        await ctx.onTaskEvent?.({
          type: 'system',
          subtype: 'task_updated',
          task_id: 'task-question-preview-31',
          patch: {
            status: 'failed',
            description: '预览参数函数辨析题，覆盖 a=0 与判别式为零两种退化情形',
            error: 'DO NOT LEAK provider stack/raw prompt',
          },
          uuid: '00000000-0000-4000-8000-000000000034',
          session_id: 'sdk-durable-session',
        });
        return {
          text: '结论：你把“导数为零”误当成了“导数必变号”。',
          task_run_id: 'tr_durable_subtasks',
          finishReason: 'end_turn',
          usage: { inputTokens: 8200, outputTokens: 1100 },
        };
      },
    );

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_durable_subtasks' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      buildTavilyMcpServerFn: () => null,
      resolveCopilotSkillsFn: async () => ['copilot'],
    });
    expect(result.status).toBe('done');

    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(ctx.allowedTools).toEqual(expect.arrayContaining(['Task']));
    expect(ctx.agents).toHaveProperty(COPILOT_SUBAGENT_NAME);
    expect(ctx.hooks).toHaveProperty('PreToolUse');
    expect(ctx.canUseTool).toEqual(expect.any(Function));
    const researcher = ctx.agents?.[COPILOT_SUBAGENT_NAME];
    expect(researcher?.tools?.every((tool) => ctx.allowedTools?.includes(tool))).toBe(true);
    expect(researcher?.tools).not.toContain('Task');
    expect(researcher?.tools).not.toContain('mcp__loom__run_task');
    expect(researcher?.tools).not.toContain('mcp__loom__author_question');

    const events = await replay(runId);
    expect(events.map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.STEP,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.STEP,
      COPILOT_RUN_EVENTS.STEP,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.STEP,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(
      events.filter((event) => event.event_type === COPILOT_RUN_EVENTS.STEP).map((e) => e.payload),
    ).toEqual([
      {
        step_kind: 'subtask',
        subtask_id: 'task-cross-artifacts-77',
        label: '交叉核对函数讲义、四次历史作答与知识图谱先修边',
        status: 'running',
      },
      {
        step_kind: 'subtask',
        subtask_id: 'task-question-preview-31',
        label: '预览参数函数辨析题，覆盖 a=0 与判别式为零两种退化情形',
        status: 'running',
      },
      {
        step_kind: 'subtask',
        subtask_id: 'task-cross-artifacts-77',
        label: '子任务已完成',
        status: 'completed',
      },
      {
        step_kind: 'subtask',
        subtask_id: 'task-question-preview-31',
        label: '预览参数函数辨析题，覆盖 a=0 与判别式为零两种退化情形',
        status: 'failed',
        error: '子任务未完成',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('DO NOT LEAK');
    expect(JSON.stringify(events)).not.toContain('/private/tmp/never-expose.txt');
  });

  it('YUK-757 — durable kill switch removes Task and spawn-only runner options', async () => {
    const run = streamMock('我会在 durable 主循环里直接完成。');
    await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: 'copilot_user_ask_durable_spawn_disabled',
        session_id: 'sess_durable_spawn_disabled',
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      copilotSubagentEnabled: false,
    });

    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(ctx.allowedTools).not.toContain('Task');
    expect(ctx).not.toHaveProperty('agents');
    expect(ctx).not.toHaveProperty('hooks');
    expect(ctx).not.toHaveProperty('canUseTool');
    expect(ctx).not.toHaveProperty('onTaskEvent');
  });

  // W5-2 (TcR8s) — the durable path exposes checkpoint_event_id via the job-events SSE endpoint, so it
  // must mirror the live/replay materializing-tool suppression. The mock stream skips the mcp-bridge,
  // so seed the tool_use mirror the run would have written under runId.
  async function seedToolUseMirror(runId: string, toolName: string) {
    await writeEvent(testDb(), {
      id: `tool_use_${runId}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'tool_use',
      subject_kind: 'query',
      subject_id: `tool_use_${runId}`,
      outcome: 'success',
      payload: { tool_name: toolName, args: {} },
      caused_by_event_id: runId,
      created_at: new Date(),
    });
  }

  it('W5-2 — omits checkpoint_event_id in reply/done when the run called a materializing tool (TcR8s)', async () => {
    const runId = 'copilot_user_ask_mat_run';
    await seedToolUseMirror(runId, 'author_question');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_mat_run' },
      streamTaskCollectingFn: streamMock('好的') as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result.status).toBe('done');

    const events = await replay(runId);
    const reply = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    const done = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.DONE);
    expect(reply?.payload).not.toHaveProperty('checkpoint_event_id');
    expect(done?.payload).not.toHaveProperty('checkpoint_event_id');
  });

  it('W5-2 — keeps checkpoint_event_id for a propose-only durable run (TcR8s)', async () => {
    const runId = 'copilot_user_ask_prop_run';
    await seedToolUseMirror(runId, 'propose_knowledge_edge');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_prop_run' },
      streamTaskCollectingFn: streamMock('已提议') as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result.status).toBe('done');

    const events = await replay(runId);
    const reply = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    const done = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.DONE);
    expect(reply?.payload).toMatchObject({ checkpoint_event_id: runId });
    expect(done?.payload).toMatchObject({ checkpoint_event_id: runId });
  });

  // YUK-765 (YUK-497 W7 · E1 / Tdtyw · commit 5859dde6) — regression pin for handleDurableFailure's
  // anchor suppression. A terminal-FAILED can follow a PARTIAL run that ALREADY called a materializing
  // tool (its tool_use mirror chains to runId), so the FAILED job event must SUPPRESS
  // checkpoint_event_id exactly like the success path — otherwise the SSE events endpoint renders a
  // revert button that 409s / orphans the materialized row. Pre-fix the FAILED payload carried the
  // anchor UNCONDITIONALLY. streamMock({partial}) drives the graceful-degrade → handleDurableFailure.
  it('E1 — partial-FAILED run that materialized a tool suppresses checkpoint_event_id (Tdtyw)', async () => {
    const runId = 'copilot_user_ask_mat_fail';
    await seedToolUseMirror(runId, 'author_question');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_mat_fail' },
      streamTaskCollectingFn: streamMock('半程后失败', {
        partial: true,
        error: 'stream drop',
      }) as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result.status).toBe('failed');

    const events = await replay(runId);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({ reason: 'exhausted' });
    // E1 red line — the anchor is OMITTED because the run materialized a row cascade-revert can't undo.
    expect(failed?.payload).not.toHaveProperty('checkpoint_event_id');
  });

  // YUK-765 (E1 paired negative) — a partial-FAILED run whose only tool was propose-only (a pure event
  // write, cascade-compensable via the deferred accept) is NOT materialized, so the FAILED anchor is
  // RETAINED — same predicate the success path keys on. Guards the suppression against over-firing.
  it('E1 — partial-FAILED propose-only run retains checkpoint_event_id', async () => {
    const runId = 'copilot_user_ask_prop_fail';
    await seedToolUseMirror(runId, 'propose_knowledge_edge');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_prop_fail' },
      streamTaskCollectingFn: streamMock('半程后失败', {
        partial: true,
        error: 'stream drop',
      }) as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result.status).toBe('failed');

    const events = await replay(runId);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({ reason: 'exhausted', checkpoint_event_id: runId });
  });

  it('E2 — post-reply projection failure redelivers into terminal repair without re-running paid work', async () => {
    const runId = 'copilot_user_ask_terminal_projection_repair';
    const sessionId = 'sess_terminal_projection_repair';
    const reply =
      '已核对 42 次含参分式方程作答、三轮延迟复习和五个未教学探针：稳定错因是先通分后补定义域，下一组按定义域→增根→参数退化分三档。';
    const streamRun = streamMock(reply, {
      taskRunId: 'tr_terminal_projection_repair',
      finishReason: 'end_turn',
    });
    const projectTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error('job_events transaction unavailable after reply commit'))
      .mockImplementation(writeSuccessfulTerminalProjection);
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      writeSuccessfulTerminalProjectionFn: projectTerminal,
    } satisfies RunCopilotRunParams;

    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    await expect(runCopilotRun(params)).rejects.toThrow(
      `durable success terminal projection failed for ${runId}`,
    );

    const persistedReplies = await copilotReplyEvents(sessionId);
    expect(persistedReplies).toHaveLength(1);
    expect(persistedReplies[0]).toMatchObject({
      outcome: 'success',
      task_run_id: 'tr_terminal_projection_repair',
      caused_by_event_id: runId,
      payload: {
        reply_md: reply,
        durable_finish_reason: 'end_turn',
      },
    });
    expect((await replay(runId)).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
    ]);
    expect(await countOutstandingDurableRuns(testDb())).toBe(1);

    const repaired = await runCopilotRun(params);
    expect(repaired).toEqual({
      status: 'done',
      reply,
      task_run_id: 'tr_terminal_projection_repair',
    });
    expect(streamRun).toHaveBeenCalledTimes(1);
    expect(projectTerminal).toHaveBeenCalledTimes(2);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    const repairedEvents = await replay(runId);
    expect(repairedEvents.map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(repairedEvents.some((item) => item.event_type === COPILOT_RUN_EVENTS.FAILED)).toBe(
      false,
    );
    expect(repairedEvents.at(-1)?.payload).toMatchObject({
      task_run_id: 'tr_terminal_projection_repair',
      finish_reason: 'end_turn',
      checkpoint_event_id: runId,
    });
    expect(await countOutstandingDurableRuns(testDb())).toBe(0);
  });

  it('E2 — failed terminal projection redelivers from its durable marker without re-running partial work', async () => {
    const runId = 'copilot_user_ask_failed_projection_repair';
    const sessionId = 'sess_failed_projection_repair';
    const partialReply =
      '已完成 42 次历史作答与三轮延迟复习的交叉核对；五个未教学探针只跑完三题，暂时只能确认“先通分后补定义域”这一条稳定错因。';
    const providerError = 'provider budget exhausted after third transfer probe';
    const streamRun = streamMock(partialReply, {
      partial: true,
      error: providerError,
      taskRunId: 'tr_failed_projection_repair',
    });
    const projectTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error('job_events FAILED write unavailable after reply commit'))
      .mockImplementation(writeFailedTerminalProjection);
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      writeFailedTerminalProjectionFn: projectTerminal,
    } satisfies RunCopilotRunParams;

    await seedToolUseMirror(runId, 'author_question');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    await expect(runCopilotRun(params)).rejects.toThrow(
      `durable failure terminal projection failed for ${runId}`,
    );

    const persistedReplies = await copilotReplyEvents(sessionId);
    expect(persistedReplies).toHaveLength(1);
    expect(persistedReplies[0]).toMatchObject({
      outcome: 'failure',
      task_run_id: `copilot_run_exhausted_${runId}`,
      caused_by_event_id: runId,
      payload: {
        reply_md: partialReply,
        durable_failure: { reason: 'exhausted', error: providerError },
      },
    });
    expect((await replay(runId)).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
    ]);
    expect(await countOutstandingDurableRuns(testDb())).toBe(1);

    const repaired = await runCopilotRun(params);
    expect(repaired).toEqual({ status: 'failed', error: providerError });
    expect(streamRun).toHaveBeenCalledTimes(1);
    expect(projectTerminal).toHaveBeenCalledTimes(2);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    const repairedEvents = await replay(runId);
    expect(repairedEvents.map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(repairedEvents.at(-1)?.payload).toMatchObject({
      reason: 'exhausted',
      error: providerError,
    });
    expect(repairedEvents.at(-1)?.payload).not.toHaveProperty('checkpoint_event_id');
    expect(await countOutstandingDurableRuns(testDb())).toBe(0);
  });

  it('YUK-757 — execution claim failure never enters paid execution and a clean redelivery may run once', async () => {
    const runId = 'copilot_user_ask_execution_fence_retry';
    const sessionId = 'sess_execution_fence_retry';
    const streamRun = streamMock(
      '已核对 36 道含参函数与电磁感应迁移题：定义域、退化分支和方向单位三类证据均已闭合。',
      { taskRunId: 'tr_execution_fence_retry' },
    );
    const claimFence = vi
      .fn()
      .mockRejectedValueOnce(new Error('execution claim commit unavailable'))
      .mockImplementation(claimCopilotExecutionFence);
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      claimExecutionFenceFn: claimFence,
    } satisfies RunCopilotRunParams;
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    await expect(runCopilotRun(params)).rejects.toThrow('execution claim commit unavailable');
    expect(streamRun).not.toHaveBeenCalled();
    expect((await replay(runId)).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
    ]);

    await expect(runCopilotRun(params)).resolves.toMatchObject({ status: 'done' });
    expect(streamRun).toHaveBeenCalledTimes(1);
    expect((await replay(runId)).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
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
      buildMcpServerFn: mcpMock() as never,
    } satisfies RunCopilotRunParams;
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
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);

    // A later pg-boss redelivery observes DONE and remains no-op.
    await expect(runCopilotRun(params)).resolves.toMatchObject({ status: 'done' });
    expect(streamRun).toHaveBeenCalledTimes(1);
  });

  it('YUK-757 — deadline recovery wins settlement once and a late paid owner cannot append success', async () => {
    const runId = 'copilot_user_ask_recovery_wins_late_owner';
    const sessionId = 'sess_recovery_wins_late_owner';
    let ownerEntered: (() => void) | undefined;
    const ownerStarted = new Promise<void>((resolve) => {
      ownerEntered = resolve;
    });
    let releaseOwner: (() => void) | undefined;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const streamRun = vi.fn(async () => {
      ownerEntered?.();
      await ownerGate;
      return {
        text: '迟到 owner 的成功文本：已物化九道含参迁移题，但不得在恢复终态之后写入对话或 DONE。',
        task_run_id: 'tr_recovery_wins_late_owner',
        finishReason: 'end_turn',
        usage: { inputTokens: 9_600, outputTokens: 1_480 },
      };
    });
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    } satisfies RunCopilotRunParams;
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    const owner = runCopilotRun(params);
    await ownerStarted;
    await testDb()
      .update(job_events)
      .set({ occurred_at: new Date(Date.now() - DURABLE_BUDGET.timeoutMs - 31_000) })
      .where(
        and(
          eq(job_events.business_table, COPILOT_RUN_TABLE),
          eq(job_events.business_id, runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.EXECUTION_STARTED),
        ),
      );

    const recovered = await runCopilotRun(params);
    expect(recovered).toEqual({
      status: 'failed',
      error: 'execution outcome could not be confirmed after worker recovery',
    });
    releaseOwner?.();
    await expect(owner).resolves.toEqual(recovered);

    expect(streamRun).toHaveBeenCalledTimes(1);
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      outcome: 'failure',
      task_run_id: `copilot_run_ambiguous_${runId}`,
      payload: { durable_failure: { reason: 'ambiguous_execution' } },
    });
    expect(String(replies[0]?.payload.reply_md)).not.toContain('迟到 owner 的成功文本');
    expect((await replay(runId)).map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(await countOutstandingDurableRuns(testDb())).toBe(0);
  });

  it('YUK-757 — lost paid outcome becomes one honest ambiguous terminal and never re-runs tools', async () => {
    const runId = 'copilot_user_ask_paid_outcome_marker_lost';
    const sessionId = 'sess_paid_outcome_marker_lost';
    const paidReply =
      '已完成 42 次真实作答、三轮延迟复习、五个未教学探针和九道新迁移题；其中 author_question 已物化三档题组。';
    const streamRun = streamMock(paidReply, {
      taskRunId: 'tr_paid_outcome_marker_lost',
      finishReason: 'end_turn',
    });
    const persistReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('domain reply marker database unavailable after tools'))
      .mockImplementation(writeCopilotReply);
    const projectFailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('FAILED projection temporarily unavailable'))
      .mockImplementation(writeFailedTerminalProjection);
    const params = {
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      writeCopilotReplyFn: persistReply,
      writeFailedTerminalProjectionFn: projectFailed,
    } satisfies RunCopilotRunParams;
    await seedToolUseMirror(runId, 'author_question');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: { session_id: sessionId, admission: 'paid-durable-slot' },
    });

    await expect(runCopilotRun(params)).rejects.toThrow(
      `durable success terminal projection failed for ${runId}`,
    );
    expect(streamRun).toHaveBeenCalledTimes(1);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(0);
    expect((await replay(runId)).map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.QUEUED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
    ]);
    expect(await countOutstandingDurableRuns(testDb())).toBe(1);

    // A genuine recovery happens only after the original 12-minute execution
    // budget has elapsed (normally pg-boss redelivers after its 2h lease). Age
    // the fence rather than mis-model an early overlap as a crashed owner.
    await testDb()
      .update(job_events)
      .set({
        occurred_at: new Date(Date.now() - DURABLE_BUDGET.timeoutMs - 31_000),
      })
      .where(
        and(
          eq(job_events.business_table, COPILOT_RUN_TABLE),
          eq(job_events.business_id, runId),
          eq(job_events.event_type, COPILOT_RUN_EVENTS.EXECUTION_STARTED),
        ),
      );

    // Redelivery sees EXECUTION_STARTED with no outcome. It writes an ambiguous marker,
    // but this injected FAILED projection loss forces one further repair pass.
    await expect(runCopilotRun(params)).rejects.toThrow(
      `durable failure terminal projection failed for ${runId}`,
    );
    expect(streamRun).toHaveBeenCalledTimes(1);
    const ambiguousReplies = await copilotReplyEvents(sessionId);
    expect(ambiguousReplies).toHaveLength(1);
    expect(ambiguousReplies[0]).toMatchObject({
      outcome: 'failure',
      task_run_id: `copilot_run_ambiguous_${runId}`,
      caused_by_event_id: runId,
      payload: {
        durable_failure: {
          reason: 'ambiguous_execution',
          error: 'execution outcome could not be confirmed after worker recovery',
        },
      },
    });
    expect(String(ambiguousReplies[0]?.payload.reply_md)).toContain('没有自动重跑');

    const repaired = await runCopilotRun(params);
    expect(repaired).toEqual({
      status: 'failed',
      error: 'execution outcome could not be confirmed after worker recovery',
    });
    expect(streamRun).toHaveBeenCalledTimes(1);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    const terminal = (await replay(runId)).at(-1);
    expect(terminal).toMatchObject({
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'ambiguous_execution',
        error: 'execution outcome could not be confirmed after worker recovery',
      },
    });
    expect(terminal?.payload).not.toHaveProperty('checkpoint_event_id');
    expect(await countOutstandingDurableRuns(testDb())).toBe(0);
  });

  it('E2 — repairing a persisted materializing success keeps the revert anchor suppressed', async () => {
    const runId = 'copilot_user_ask_materialized_terminal_repair';
    const sessionId = 'sess_materialized_terminal_repair';
    await seedToolUseMirror(runId, 'author_question');
    await writeEvent(testDb(), {
      id: 'copilot_reply_materialized_terminal_repair',
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: 'copilot_reply_materialized_terminal_repair',
      outcome: 'success',
      payload: {
        surface: 'copilot',
        session_id: sessionId,
        reply_md: '已生成 12 道三档迁移题，并用五个未教学探针逐题验证定义域、增根与参数退化。',
        task_run_id: 'tr_materialized_terminal_repair',
        durable_finish_reason: 'end_turn',
        in_reply_to_event_id: runId,
      },
      caused_by_event_id: runId,
      task_run_id: 'tr_materialized_terminal_repair',
      created_at: new Date(),
    });
    const streamRun = streamMock('不得再次运行');

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamRun as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({
      status: 'done',
      reply: '已生成 12 道三档迁移题，并用五个未教学探针逐题验证定义域、增根与参数退化。',
      task_run_id: 'tr_materialized_terminal_repair',
    });
    expect(streamRun).not.toHaveBeenCalled();
    const events = await replay(runId);
    expect(events.map((item) => item.event_type)).toEqual([
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(events[0]?.payload).not.toHaveProperty('checkpoint_event_id');
    expect(events[1]?.payload).not.toHaveProperty('checkpoint_event_id');
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
  });

  it.each([COPILOT_RUN_EVENTS.REPLY, COPILOT_RUN_EVENTS.DONE])(
    'E2 — transactional success projection rolls back both frames when %s write fails',
    async (failedType) => {
      const runId = `copilot_user_ask_atomic_${failedType.split('.').at(-1)}`;
      const writeInTransaction = vi.fn(
        async (
          tx: Parameters<typeof writeJobEvent>[0],
          input: Parameters<typeof writeJobEvent>[1],
        ) => {
          if (input.event_type === failedType) {
            throw new Error(`injected ${failedType} write failure`);
          }
          return writeJobEvent(tx, input);
        },
      );

      await expect(
        writeSuccessfulTerminalProjection(
          testDb(),
          {
            runId,
            replyMd: '真实复杂终稿：42 次作答、三轮延迟复习、五个未教学探针均已交叉验证。',
            taskRunId: `tr_atomic_${failedType.split('.').at(-1)}`,
            finishReason: 'end_turn',
          },
          [],
          { writeJobEventFn: writeInTransaction },
        ),
      ).rejects.toThrow(`injected ${failedType} write failure`);

      expect(await replay(runId)).toEqual([]);
    },
  );

  it('F1 — primary_view marker 在 domain event 与 job_events 里都被剥掉', async () => {
    const runId = 'run_primary_view';
    const sessionId = 'sess_primary_view';
    const marked =
      '这是正文\n<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_1"}}-->';
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: streamMock(marked) as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result).toEqual({ status: 'done', reply: '这是正文', task_run_id: 'tr_x' });

    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({
      reply_md: '这是正文',
      primary_view: { source: 'artifact', ref: { kind: 'question', id: 'q_1' } },
    });

    const events = await replay(runId);
    const replyJobEvent = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    expect(replyJobEvent?.payload).toMatchObject({ reply_md: '这是正文' });
  });

  // YUK-575 (N2/S3) — 流式 delta → job_events：FIFO + terminal 前 drain → 每条 delta id
  // 严格早于 REPLY/DONE，且 job_events id 单调。
  it('N2/S3 — 流式 delta 写 job_events，id 单调、所有 delta 严格早于 REPLY/DONE', async () => {
    const runId = 'run_delta_fifo';
    const run = streamMock('最终答复', { deltas: ['最', '终', '答复'] });
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_delta_fifo' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result.status).toBe('done');

    const events = await replay(runId);
    // id 单调递增。
    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // 事件序列：STARTED, EXECUTION_STARTED, 3×DELTA, REPLY, DONE。
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    // S3 红线：每条 DELTA id 严格 < REPLY id 且 < DONE id（drain 生效，重放不乱序）。
    const maxDeltaId = Math.max(
      ...events.filter((e) => e.event_type === COPILOT_RUN_EVENTS.DELTA).map((e) => e.id),
    );
    const replyId = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY)?.id ?? 0;
    const doneId = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.DONE)?.id ?? 0;
    expect(maxDeltaId).toBeLessThan(replyId);
    expect(replyId).toBeLessThan(doneId);
    // delta payload 携带文本。
    const firstDelta = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.DELTA);
    expect(firstDelta?.payload).toMatchObject({ text: '最' });
    // 流式态派生为 running（终态 done 前）。
    expect(deriveCopilotRunStatus(events.slice(0, 4))).toBe('running');
  });

  // YUK-596 (causal history + S4) — handler pickup 时调共享装配器，传
  // historyAnchorEventId=run_id 且 ambient RIDE 自 job payload 进装配参数。
  it('N3/S4 — 装配器收到 historyAnchorEventId=run_id + ambient（从 job payload 透传）', async () => {
    const runId = 'run_assemble_params';
    const assembleSpy = vi.fn(stubRunInput);
    const run = streamMock('ok');
    const ambient = { route: '/learn/q_9', focused_entity: { kind: 'knowledge', id: 'k_9' } };
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_assemble', ambient },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: assembleSpy,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(assembleSpy).toHaveBeenCalledTimes(1);
    const params = assembleSpy.mock.calls[0][1];
    expect(params).toMatchObject({
      sessionId: 'sess_assemble',
      userMessage: baseData.user_message,
      triggeredBy: 'chat',
      historyAnchorEventId: runId,
      ambient,
    });
    // 装配器返回的 run input（含 ambient_context）透传给 stream。
    const runInput = await assembleSpy.mock.results[0].value;
    expect(runInput).toMatchObject({ ambient_context: ambient });
    // N3 wiring 红线（PR #738 独立 review fix-before-merge）：stream 收到的 arg[1] 必须
    // ===（引用相等）装配器的返回对象。此前所有 run.mock.calls[0] 断言只读 ctx（arg[2]）、
    // 且上一行只是复读 stub 自身返回值——handler 把 {} / 错对象递给 runner 会全绿通过；
    // 这条断言封死 handler→runner 的 wiring 回归（PR2 默认翻转恰要重构此 seam）。
    expect(run.mock.calls[0][1]).toBe(runInput);
  });

  // YUK-575 (N5/MF-A) — durable budget：runner budgetOverride（maxIterations/timeoutMs）
  // 经 ctx 透传；durable 在 25 发 advisory warning、60 才 hard-stop。
  it('N5/MF-A — budgetOverride 透传 + durable tool-call warning 25 / hard 60', async () => {
    const runId = 'run_budget';
    const run = streamMock('ok');
    const buildMcp = mcpMock();
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_budget' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: buildMcp as never,
    });
    // runner seam：ctx.budgetOverride = { maxIterations:24, timeoutMs:12min }。
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(ctx.budgetOverride).toEqual({
      maxIterations: DURABLE_BUDGET.maxIterations,
      timeoutMs: DURABLE_BUDGET.timeoutMs,
    });
    // MF-A + YUK-290：25 只是 warning，60 才是 hard ceiling。
    const opts = (
      buildMcp.mock.calls[0] as unknown as [
        {
          beforeExecute: (t: unknown) => string | undefined;
          interceptInput: (t: unknown, args: unknown) => { truncationNote?: object | null };
        },
      ]
    )[0];
    const fakeTool = { name: 'query_knowledge', effect: 'read' };
    for (let i = 0; i < 25; i++) expect(opts.beforeExecute(fakeTool)).toBeUndefined();
    expect(opts.interceptInput(fakeTool, {}).truncationNote).toMatchObject({
      level: 'warning',
      dimensions: { toolCalls: { used: 25, hard_remaining: 35 } },
    });
    for (let i = 25; i < 60; i++) expect(opts.beforeExecute(fakeTool)).toBeUndefined();
    expect(opts.beforeExecute(fakeTool)).toMatch(/hard context budget reached/);
    // 常量对齐。
    expect(DURABLE_BUDGET).toMatchObject({
      maxIterations: 24,
      maxToolCalls: 60,
      timeoutMs: 720_000,
    });
  });

  // YUK-575 (S6) — 承重约束：durable abort budget 必须 < stuck-in-running sweeper 阈值，
  // 否则 sweeper 误收敛 live durable run 成 failure。
  it('S6 — DURABLE_BUDGET.timeoutMs < STUCK_RUN_THRESHOLD_MS', () => {
    expect(DURABLE_BUDGET.timeoutMs).toBeLessThan(STUCK_RUN_THRESHOLD_MS);
  });

  it('F3 — 已有 DONE 终态的 run 被重投 → 跳过，不重跑 AI、不重写事件/回复', async () => {
    const runId = 'run_terminal_done';
    const sessionId = 'sess_terminal_done';
    const data = { ...baseData, run_id: runId, session_id: sessionId };

    const run = streamMock('第一次回答');
    await runCopilotRun({
      db: testDb(),
      data,
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    const firstEvents = await replay(runId);

    const result2 = await runCopilotRun({
      db: testDb(),
      data,
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result2).toMatchObject({ status: 'done', reply: '第一次回答', task_run_id: 'tr_x' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    const secondEvents = await replay(runId);
    expect(secondEvents.map((e) => e.event_type)).toEqual(firstEvents.map((e) => e.event_type));
  });

  it('YUK-757 — claimed-owner polling ignores retryable error frames but wakes on deliberate settlement', () => {
    const retryable = {
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'error', error: 'transient provider gateway reset' },
    };
    expect(hasCopilotSettlementTerminal([retryable])).toBe(false);
    expect(
      hasCopilotSettlementTerminal([
        retryable,
        {
          event_type: COPILOT_RUN_EVENTS.FAILED,
          payload: {
            reason: 'exhausted',
            error: 'validator batch retry budget exhausted',
          },
        },
      ]),
    ).toBe(true);
    expect(
      hasCopilotSettlementTerminal([
        retryable,
        { event_type: COPILOT_RUN_EVENTS.DONE, payload: { task_run_id: 'tr_retry_success' } },
      ]),
    ).toBe(true);
  });

  it('C1 — 已有 FAILED(reason=error) 的 run 被重投 → 重跑（不在 skip-guard，恢复 retry）', async () => {
    const runId = 'run_terminal_failed';
    const sessionId = 'sess_terminal_failed';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'error', error: 'mimo 500' },
    });
    const run = streamMock('重试成功的回答');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result).toMatchObject({ status: 'done', reply: '重试成功的回答' });
    expect(run).toHaveBeenCalledTimes(1);
    const events = await replay(runId);
    expect(events.map((e) => e.event_type)).toEqual([
      COPILOT_RUN_EVENTS.FAILED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(deriveCopilotRunStatus(events)).toBe('done');
  });

  it("YUK-757 — retryable error does not suppress the retried attempt's exhausted terminal", async () => {
    const runId = 'run_retryable_error_then_exhausted';
    const sessionId = 'sess_retryable_error_then_exhausted';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'error', error: 'transient provider gateway reset' },
    });
    const run = streamMock('已核对 31 道真实作答与四个未教学探针，但第三档迁移题在预算内未完成。', {
      partial: true,
      error: 'retry budget exhausted after validator batch 7',
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({
      status: 'failed',
      error: 'retry budget exhausted after validator batch 7',
    });
    expect(run).toHaveBeenCalledTimes(1);
    const events = await replay(runId);
    expect(events.map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.FAILED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: 'exhausted',
      error: 'retry budget exhausted after validator batch 7',
    });
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
  });

  it('C1 — 已有 FAILED(reason=cancelled) 的 run 被重投 → 早停返回 cancelled，不重跑', async () => {
    const runId = 'run_terminal_cancelled';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'cancelled', cancelled_before_start: true },
    });
    const run = streamMock('不该被调用');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_terminal_cancelled' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
    const events = await replay(runId);
    expect(events.map((e) => e.event_type)).toEqual([COPILOT_RUN_EVENTS.FAILED]);
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
      buildMcpServerFn: mcpMock() as never,
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

  it('YUK-757 — a late pg-boss delivery behind enqueue_failed never starts paid execution', async () => {
    const runId = 'run_late_delivery_after_enqueue_failed';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'enqueue_failed', checkpoint_event_id: runId },
    });
    const run = streamMock('不应该在公开 enqueue_failed 之后仍执行 48 道作答与六个未教学探针。');

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_late_enqueue_failed' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({ status: 'failed', error: 'enqueue_failed' });
    expect(run).not.toHaveBeenCalled();
    expect((await replay(runId)).map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(await copilotReplyEvents('sess_late_enqueue_failed')).toHaveLength(0);
  });

  // YUK-575 (MF2b) — 已有 FAILED(reason=exhausted) 的 run 被重投（写完 terminal 后崩溃）→
  // 早停返回 failed，不重跑重烧、不写新 reply。
  it('MF2b — 已有 FAILED(reason=exhausted) 的 run 被重投 → 早停 failed，不重跑', async () => {
    const runId = 'run_prior_exhausted';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'exhausted', error: 'error_max_turns' },
    });
    const run = streamMock('不该被调用');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_prior_exhausted' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result).toMatchObject({ status: 'failed', error: 'error_max_turns' });
    expect(run).not.toHaveBeenCalled();
    const events = await replay(runId);
    expect(events.map((e) => e.event_type)).toEqual([COPILOT_RUN_EVENTS.FAILED]);
    expect(await copilotReplyEvents('sess_prior_exhausted')).toHaveLength(0);
  });

  it('C5 — 配置 TAVILY_API_KEY 时挂 Tavily MCP + allowedTools（web grounding 平价）', async () => {
    const runId = 'run_tavily';
    const run = streamMock('grounded reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_tavily' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      buildTavilyMcpServerFn: () => ({ type: 'http', url: 'https://mcp.tavily.com/mcp/?k' }),
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(Object.keys(ctx.mcpServers ?? {})).toContain('tavily');
    expect(ctx.allowedTools).toEqual(
      expect.arrayContaining(['mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract']),
    );
  });

  it('C5 — 未配置 Tavily（builder 返 null）→ 不挂 tavily server / tools（back-compat）', async () => {
    const runId = 'run_no_tavily';
    const run = streamMock('reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_no_tavily' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      buildTavilyMcpServerFn: () => null,
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(Object.keys(ctx.mcpServers ?? {})).not.toContain('tavily');
    expect(ctx.allowedTools ?? []).not.toContain('mcp__tavily__tavily_search');
  });

  it('C2 — copilot SKILL.md 命中时传 ctx.skills（durable 与 inline 行为平价）', async () => {
    const runId = 'run_skills';
    const run = streamMock('reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_skills' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      resolveCopilotSkillsFn: async () => ['copilot'],
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(ctx.skills).toEqual(['copilot']);
  });

  it('C2 — SKILL.md 缺包（resolver 返 undefined）→ ctx 省略 skills（降级，零回归）', async () => {
    const runId = 'run_no_skills';
    const run = streamMock('reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_no_skills' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      resolveCopilotSkillsFn: async () => undefined,
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(ctx.skills).toBeUndefined();
  });

  // YUK-575 (Fix 2 — single-shot) — durable copilot 无 transient 分诊：任何失败都是
  // deliberate terminal → failure-marker copilot_reply + FAILED(reason='exhausted') +
  // return（终态写成功时不 throw、不 redeliver，与 inline copilot 一致）。终态投影
  // 失败的无重跑修复由上方 E2 覆盖；真 transient runner 自动重试延到 YUK-596。
  it('② 任何失败（这里 plain Error）→ terminal FAILED(exhausted) + copilot_reply + return（不 throw）', async () => {
    const run = vi.fn(async () => {
      throw new Error('handler bug / unknown failure');
    });
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: 'run_fail', session_id: 'sess_fail' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result).toMatchObject({ status: 'failed', error: 'handler bug / unknown failure' });
    const events = await replay('run_fail');
    expect(events.map((e) => e.event_type)).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({
      reason: 'exhausted',
      checkpoint_event_id: 'run_fail',
    });
    expect(deriveCopilotRunStatus(events)).toBe('failed');
    // phantom-prevention：写了 error copilot_reply（chained user_ask=run_id）。
    const replies = await copilotReplyEvents('sess_fail');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      caused_by_event_id: 'run_fail',
      actor_ref: 'agent:copilot',
    });
  });

  // YUK-575 (partial) — streamTaskCollecting graceful-degrade（resolve partial，不 throw）
  // → terminal-no-retry：FAILED(exhausted) + 半程文本作 reply + return。
  it('partial — streamTaskCollecting graceful-degrade → FAILED(exhausted) + 半程文本 reply', async () => {
    const runId = 'run_partial';
    const run = streamMock('半程答复', { partial: true, error: 'stream drop' });
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_partial' },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result.status).toBe('failed');
    const events = await replay(runId);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({
      reason: 'exhausted',
      checkpoint_event_id: runId,
    });
    // 半程文本落进 phantom-preventing reply（不丢已说的话）。
    const replies = await copilotReplyEvents('sess_partial');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({ reply_md: '半程答复' });
  });

  it('③ 启动前已有 cancel 事件 → 早停写 failed(cancelled)，不调 AI', async () => {
    const runId = 'run_cancelled';
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      payload: { by: 'user' },
    });

    const run = streamMock('不该被调用');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
    const events = await replay(runId);
    expect(events.map((e) => e.event_type)).toEqual([
      COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({
      reason: 'cancelled',
      cancelled_before_start: true,
      checkpoint_event_id: runId,
    });
  });

  it('④ run handle = run_id = job_events.business_id（checkpoint_id 即 handle）', async () => {
    const runId = 'copilot_user_ask_handle_check';
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId },
      streamTaskCollectingFn: streamMock('ok') as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });
    const events = await replay(runId);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.business_table).toBe(COPILOT_RUN_TABLE);
      expect(e.business_id).toBe(runId);
    }
  });
});

describe('buildCopilotRunHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('缺字段的 job 被 warn 跳过，不崩、不写事件、不调 AI', async () => {
    const db = testDb();
    const handler = buildCopilotRunHandler(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      handler([
        { id: 'j2', data: { run_id: '', user_message: '', triggered_by: 'chat' } },
        { id: 'j3', data: undefined },
      ] as never),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const skipped = await computeReplay(db, {
      businessTable: COPILOT_RUN_TABLE,
      businessId: '',
      lastEventId: 0,
    });
    expect(skipped).toHaveLength(0);
    warn.mockRestore();
  });
});
