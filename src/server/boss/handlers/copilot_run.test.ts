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
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/server/ai/tools/allowlists';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type CopilotRunJobData, buildCopilotRunHandler, runCopilotRun } from './copilot_run';

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
