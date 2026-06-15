// YUK-364 — durable copilot run handler DB test。
//
// mock AI（runAgentTaskFn）+ real DB（job_events writeJobEvent / computeReplay）。
// 断言：
//   ① happy path 写 started→reply→done 事件序列 + computeReplay 末态 done；
//   ② AI throw → 写 failed 事件 + re-throw（pg-boss retry）；
//   ③ 启动前已有 cancel 事件 → 早停写 failed(cancelled)，不调 AI；
//   ④ run handle = run_id = 传入 checkpoint_id（job_events.business_id）。

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
import { type CopilotRunJobData, buildCopilotRunHandler, runCopilotRun } from './copilot_run';

// YUK-364 (F1) — 读 conversation-历史可见的 copilot_reply domain event（turns.ts 读
// 的就是这族 experimental:copilot_reply）。durable 成功路径必须写它，否则回复对历史
// 不可见、user_ask 成 phantom。
async function copilotReplyEvents(sessionId: string) {
  return testDb()
    .select()
    .from(event)
    .where(and(eq(event.session_id, sessionId), eq(event.action, 'experimental:copilot_reply')));
}

// runAgentTaskFn 的 ctx 形（db + mcpServers + allowedTools），让 mock.calls[0]
// 携带 typed tuple。
type AgentCtx = {
  db: unknown;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
};

function agentMock(text: string, taskRunId = 'tr_x', finishReason = 'end_turn') {
  return vi.fn(async (_kind: string, _input: unknown, _ctx: AgentCtx) => ({
    text,
    task_run_id: taskRunId,
    finishReason,
    usage: { inputTokens: 0, outputTokens: 0 },
  }));
}

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
    const run = agentMock('这是回答');
    const result = await runCopilotRun({
      db: testDb(),
      data: baseData,
      runAgentTaskFn: run as never,
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
    // reply 事件携带终稿文本 + task_run_id。
    const replyEvent = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    expect(replyEvent?.payload).toMatchObject({ reply_md: '这是回答', task_run_id: 'tr_x' });
    // 状态派生 → done。
    expect(deriveCopilotRunStatus(events)).toBe('done');

    // YUK-364 (F1) — 成功路径同时写 conversation-历史可见的 copilot_reply domain
    // event（chained user_ask = run_id，同 session_id），否则回复对历史不可见。
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
      runAgentTaskFn: agentMock(marked) as never,
      buildMcpServerFn: mcpMock() as never,
    });
    // handler 返回的 reply 已剥 marker。
    expect(result).toEqual({ status: 'done', reply: '这是正文', task_run_id: 'tr_x' });

    // domain event reply_md 剥了 marker + 带 primary_view metadata。
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({
      reply_md: '这是正文',
      primary_view: { source: 'artifact', ref: { kind: 'question', id: 'q_1' } },
    });

    // job_events REPLY 持久化的也是 cleaned 文本（与 domain event 一致，不含 marker）。
    const events = await replay(runId);
    const replyJobEvent = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    expect(replyJobEvent?.payload).toMatchObject({ reply_md: '这是正文' });
  });

  it('F3 — 已有 DONE 终态的 run 被重投 → 跳过，不重跑 AI、不重写事件/回复', async () => {
    const runId = 'run_terminal_done';
    const sessionId = 'sess_terminal_done';
    const data = { ...baseData, run_id: runId, session_id: sessionId };

    // 第一次：正常跑完。
    const run = agentMock('第一次回答');
    await runCopilotRun({
      db: testDb(),
      data,
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const firstReplies = await copilotReplyEvents(sessionId);
    expect(firstReplies).toHaveLength(1);
    const firstEvents = await replay(runId);

    // 第二次：模拟 retry / redelivery —— 同 run_id 再投一次。
    const result2 = await runCopilotRun({
      db: testDb(),
      data,
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
    });
    // 返回现有终态。
    expect(result2.status).toBe('done');
    expect(result2).toMatchObject({ status: 'done', reply: '第一次回答', task_run_id: 'tr_x' });
    // AI 没被再调（无重复副作用 / 重复 STARTED/REPLY/DONE）。
    expect(run).toHaveBeenCalledTimes(1);
    // 没有第二条 copilot_reply domain event（不重写历史）。
    expect(await copilotReplyEvents(sessionId)).toHaveLength(1);
    // job_events 序列不变（无重复 STARTED/REPLY/DONE）。
    const secondEvents = await replay(runId);
    expect(secondEvents.map((e) => e.event_type)).toEqual(firstEvents.map((e) => e.event_type));
  });

  it('C1 — 已有 FAILED(transient) 的 run 被重投 → 重跑 AI（不绕过 retry）', async () => {
    const runId = 'run_terminal_failed';
    const sessionId = 'sess_terminal_failed';
    // 预写一条普通 FAILED（模拟上次 transient 模型/工具故障，catch 写 failed +
    // re-throw → pg-boss redeliver 又投了一次）。
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'error', error: 'mimo 500' },
    });
    const run = agentMock('重试成功的回答');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
    });
    // C1 红线：普通 FAILED 不跳过——pg-boss redeliver 真正重跑（retry 语义恢复），
    // 一次 transient 故障不会被首次尝试变成永久失败。
    expect(result).toMatchObject({ status: 'done', reply: '重试成功的回答' });
    expect(run).toHaveBeenCalledTimes(1);

    // 重跑写了新一轮 STARTED→REPLY→DONE（接在旧 FAILED 之后），末态派生为 done。
    const events = await replay(runId);
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      COPILOT_RUN_EVENTS.FAILED,
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(deriveCopilotRunStatus(events)).toBe('done');
    // 重跑写了 conversation-历史可见的 copilot_reply domain event。
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({ reply_md: '重试成功的回答' });
  });

  it('C1 — 已有 FAILED(reason=cancelled) 的 run 被重投 → 早停返回 cancelled，不重跑', async () => {
    const runId = 'run_terminal_cancelled';
    const sessionId = 'sess_terminal_cancelled';
    // 预写 cancelled-before-start 终态（落在 FAILED(reason='cancelled')）。取消是
    // 用户意图的 deliberate 终态——重投不应重跑（重跑违背用户意图）。
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'cancelled', cancelled_before_start: true },
    });
    const run = agentMock('不该被调用');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
    // 早停不写新事件（序列只剩预写的那条 FAILED）。
    const events = await replay(runId);
    expect(events.map((e) => e.event_type)).toEqual([COPILOT_RUN_EVENTS.FAILED]);
  });

  it('C5 — 配置 TAVILY_API_KEY 时挂 Tavily MCP + allowedTools（web grounding 平价）', async () => {
    const runId = 'run_tavily';
    const run = agentMock('grounded reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_tavily' },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
      // 注入 Tavily fixture（不碰 process.env）。
      buildTavilyMcpServerFn: () => ({ type: 'http', url: 'https://mcp.tavily.com/mcp/?k' }),
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    // mcpServers 含 tavily server；allowedTools 含 tavily 工具。
    expect(Object.keys(ctx.mcpServers ?? {})).toContain('tavily');
    expect(ctx.allowedTools).toEqual(
      expect.arrayContaining(['mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract']),
    );
  });

  it('C5 — 未配置 Tavily（builder 返 null）→ 不挂 tavily server / tools（back-compat）', async () => {
    const runId = 'run_no_tavily';
    const run = agentMock('reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_no_tavily' },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
      buildTavilyMcpServerFn: () => null,
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(Object.keys(ctx.mcpServers ?? {})).not.toContain('tavily');
    expect(ctx.allowedTools ?? []).not.toContain('mcp__tavily__tavily_search');
  });

  it('C2 — copilot SKILL.md 命中时传 ctx.skills（durable 与 inline 行为平价）', async () => {
    const runId = 'run_skills';
    const run = agentMock('reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_skills' },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
      resolveCopilotSkillsFn: async () => ['copilot'],
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, { skills?: string[] }])[2];
    expect(ctx.skills).toEqual(['copilot']);
  });

  it('C2 — SKILL.md 缺包（resolver 返 undefined）→ ctx 省略 skills（降级，零回归）', async () => {
    const runId = 'run_no_skills';
    const run = agentMock('reply');
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_no_skills' },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
      resolveCopilotSkillsFn: async () => undefined,
    });
    const ctx = (run.mock.calls[0] as unknown as [string, unknown, { skills?: string[] }])[2];
    expect(ctx.skills).toBeUndefined();
  });

  it('② AI throw → 写 failed 事件 + re-throw', async () => {
    const run = vi.fn(async () => {
      throw new Error('mimo 502');
    });
    await expect(
      runCopilotRun({
        db: testDb(),
        data: { ...baseData, run_id: 'run_fail' },
        runAgentTaskFn: run as never,
        buildMcpServerFn: mcpMock() as never,
      }),
    ).rejects.toThrow('mimo 502');

    const events = await replay('run_fail');
    const types = events.map((e) => e.event_type);
    // started 已写，然后 failed（reply/done 未到）。
    expect(types).toEqual([COPILOT_RUN_EVENTS.STARTED, COPILOT_RUN_EVENTS.FAILED]);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({ reason: 'error', error: 'mimo 502' });
    expect(deriveCopilotRunStatus(events)).toBe('failed');
  });

  it('③ 启动前已有 cancel 事件 → 早停写 failed(cancelled)，不调 AI', async () => {
    const runId = 'run_cancelled';
    // 预写一条取消请求（模拟别处投递的协作取消）。
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      payload: { by: 'user' },
    });

    const run = agentMock('不该被调用');
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId },
      runAgentTaskFn: run as never,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    // AI 未被调用（早停在 SDK run 之前）。
    expect(run).not.toHaveBeenCalled();

    const events = await replay(runId);
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([COPILOT_RUN_EVENTS.CANCEL_REQUESTED, COPILOT_RUN_EVENTS.FAILED]);
    const failed = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({ reason: 'cancelled', cancelled_before_start: true });
  });

  it('④ run handle = run_id = job_events.business_id（checkpoint_id 即 handle）', async () => {
    const runId = 'copilot_user_ask_handle_check';
    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId },
      runAgentTaskFn: agentMock('ok') as never,
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
    // 仅投缺字段 job——合法 job 会走 real runAgentTask（无 seam，会真打 AI），
    // 业务路径已由上面注入 seam 的 runCopilotRun 用例覆盖；本用例只验证工厂的
    // 遍历/跳过纪律不外呼、不污染。
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
