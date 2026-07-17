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

import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  deriveCopilotRunStatus,
} from '@/capabilities/copilot/server/copilot-run-status';
import { event } from '@/db/schema';
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
  runCopilotRun,
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

// 假 MCP server seam（buildMcpServerFromRegistry 默认会拉 CORE_TOOLS；测试隔离用
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
    // 事件序列：STARTED, 3×DELTA, REPLY, DONE。
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
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

  // YUK-575 (N3/A1/MF-B + S4) — handler pickup 时调共享装配器，传 excludeUserAskEventId=
  // run_id 且 ambient RIDE 自 job payload 进装配参数。
  it('N3/S4 — 装配器收到 excludeUserAskEventId=run_id + ambient（从 job payload 透传）', async () => {
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
      excludeUserAskEventId: runId,
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
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(deriveCopilotRunStatus(events)).toBe('done');
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
  // deliberate terminal → FAILED(reason='exhausted') + phantom-preventing copilot_reply +
  // return（不 throw、不 redeliver，与 inline copilot 一致）。取代旧 ②「一律
  // FAILED(error) + re-throw」。真 transient 自动重试延到 YUK-596。
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
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({ reason: 'exhausted' });
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
    expect(failed?.payload).toMatchObject({ reason: 'exhausted' });
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
    expect(failed?.payload).toMatchObject({ reason: 'cancelled', cancelled_before_start: true });
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
