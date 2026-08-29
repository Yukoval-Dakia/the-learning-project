// YUK-364 / YUK-575 — durable copilot run handler DB test。
//
// mock stream AI（streamTaskCollectingFn）+ 共享装配器 stub（resolveCopilotRunInputFn）
// + real DB（job_events writeJobEvent / computeReplay）。断言：
//   ① happy path 写 started→reply→done 事件序列 + computeReplay 末态 done；
//   ② 非 transient error（plain Error）→ terminal FAILED(exhausted)+reply+return（不 throw，YUK-575 MF1）；
//   ③ 启动前已有 cancel 事件 → 早停写 failed(cancelled)，不调 AI；
//   ④ run handle = run_id = 传入 checkpoint_id（job_events.business_id）。
//   YUK-575/YUK-832: N2 reviewed full-delta settlement（S3）/ N3+S4 ambient 装配往返 / N5+MF-A budget /
//            MF1/MF2 transient·exhausted 分诊 + 幂等守卫 / S6 static 约束。

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCopilotReply } from '@/capabilities/copilot/server/chat';
import { COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY } from '@/capabilities/copilot/server/content-validation';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  deriveCopilotRunStatus,
} from '@/capabilities/copilot/server/copilot-run-status';
import { countOutstandingDurableRuns } from '@/capabilities/copilot/server/durable-backlog';
import { withCopilotDurableDispatchLock } from '@/capabilities/copilot/server/durable-dispatch';
import {
  COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
  COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS,
  COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS,
} from '@/capabilities/copilot/server/evidence-review';
import type { Db } from '@/db/client';
import { ai_task_runs, event, job_events, provider_session_admission } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import {
  acquireProviderSession,
  resolveProviderSessionAdmissionPlan,
} from '@/server/ai/provider-session-admission';
import { createRunLifecycle } from '@/server/ai/run-lifecycle';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import { STUCK_RUN_THRESHOLD_MS } from '@/server/boss/handlers/ai_task_run_reconcile';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  CLAIMED_EXECUTION_SETTLE_GRACE_MS,
  type CopilotRunJobData,
  DURABLE_BUDGET,
  DURABLE_OWNER_SETTLEMENT_BUDGET_MS,
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
  taskRunId?: string;
  parentTaskRunId?: string;
  signal?: AbortSignal;
  lifecycleAbortController?: AbortController;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  skills?: string[];
  budgetOverride?: { maxIterations?: number; timeoutMs?: number };
  sdkSession?: { persist: boolean; resume?: string };
  providerSessionDeadlineAt?: number;
  agents?: Record<string, { tools?: string[] }>;
  hooks?: { PreToolUse?: Array<{ hooks: Array<(...args: unknown[]) => Promise<unknown>> }> };
  canUseTool?: (...args: unknown[]) => unknown;
  onTaskEvent?: (event: unknown) => void | Promise<void>;
};

// streamTaskCollecting mock — 匹配 (kind, input, ctx, onDelta) => Promise<StreamCollectResult>。
// deltas 若给则在 resolve 前逐个 onDelta（模拟 primary stream 曾产生正文）；handler
// 只保留这个布尔事实，审阅后由 settlement 投影一条完整安全 DELTA。partial/error 模拟
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

function targetedRunInput(
  targetId: string,
): NonNullable<RunCopilotRunParams['resolveCopilotRunInputFn']> {
  return async (_db, params) => ({
    surface: params.triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot',
    triggered_by: params.triggeredBy,
    user_message: params.userMessage,
    proposal_feedback: [],
    conversation_history: [
      { role: 'ai', text: '水箱 D02：原推导用了错误高度。', event_id: targetId },
    ],
    correction_contract: {
      target_prior_turn_id: targetId,
      available_prior_turn_ids: [targetId],
      prior_turn_summaries: { [targetId]: '水箱 D02：原推导用了错误高度。' },
      required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
    },
  });
}

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

  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      taskRunId: `copilot_run_tool_${baseData.run_id}`,
    });

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

  it('fails closed when a durable solution reply omits the learning-content marker', async () => {
    const runId = 'copilot_user_ask_durable_unverified_solution';
    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: 'sess_durable_unverified_solution',
        user_message: '请计算 1+1。',
      },
      streamTaskCollectingFn: streamMock('解：1+1=3。') as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toMatchObject({
      status: 'done',
      reply: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY,
    });
    expect(JSON.stringify(await replay(runId))).not.toContain('1+1=3');
  });

  it.each([
    {
      label: 'numeric character references',
      html: '<section><h2>&#39064;&#30446;</h2><p>17×19？</p><p>&#31572;&#26696;&#65306;323</p></section>',
    },
    {
      label: 'inline tags splitting assessment labels',
      html: '<section><h2>题<span>目</span></h2><p>17×19？</p><p>答<span>案</span>：323</p></section>',
    },
  ])('fails closed for durable ephemeral HTML hidden with $label', async ({ html }) => {
    const runId = `copilot_user_ask_durable_obfuscated_${html.includes('&#') ? 'entity' : 'tag'}`;
    const marker = `<!--primary_view:${JSON.stringify({ source: 'ephemeral_html', ref: html })}-->`;

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: `${runId}_session`,
        user_message: '请生成一道乘法题。',
      },
      streamTaskCollectingFn: streamMock(`请在卡片里作答。\n${marker}`) as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toMatchObject({
      status: 'done',
      reply: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY,
    });
    expect(JSON.stringify(await replay(runId))).not.toContain('323');
  });

  it('provides durable artifact tools a parent-bound learning validator', async () => {
    const runId = 'copilot_user_ask_durable_artifact_parent';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const validationRunner = vi.fn(async (kind: string, _input: unknown, ctx: AgentCtx) => {
      expect(ctx).toMatchObject({
        parentTaskRunId: `copilot_run_tool_${runId}`,
      });
      if (kind === 'QuizVerifyTask') {
        return {
          task_run_id: 'durable_verify',
          text: JSON.stringify({
            grounding: { verdict: 'pass', reason: 'self-contained' },
            copy_safety: { verdict: 'original', max_overlap: 0 },
            knowledge_hit: { verdict: 'pass', reason: 'on-topic' },
            overall: 'pass',
            summary_md: 'pass',
            confidence: 0.99,
          }),
        };
      }
      if (kind === 'SolutionGenerateTask') {
        return {
          task_run_id: 'durable_solve',
          text: JSON.stringify({
            reference_solution: {
              final_answer: '2',
              expected_signals: ['1+1=2'],
              answer_equivalents: [],
            },
            worked_solution_md: '1+1=2',
            confidence: 0.99,
          }),
        };
      }
      if (kind === 'SemanticJudgeTask') {
        return {
          task_run_id: 'durable_semantic',
          text: JSON.stringify({
            score: 1,
            coarse_outcome: 'correct',
            confidence: 0.99,
            feedback_md: 'equivalent',
            evidence_json: { matched_points: ['1+1=2'], missing_points: [] },
          }),
        };
      }
      return {
        task_run_id: 'durable_teaching',
        text: JSON.stringify({
          clarity: { verdict: 'pass', reason: 'clear' },
          unique_answer: { verdict: 'pass', reason: 'unique' },
          summary: 'pass',
        }),
      };
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, _onDelta: (t: string) => void) => {
        if (!mcpOptions?.ctx.validateLearningContent) {
          throw new Error('durable validator port was not mounted');
        }
        const validation = await mcpOptions.ctx.validateLearningContent({
          subjectId: 'math',
          questions: [
            {
              id: 'q1',
              kind: 'computation',
              prompt_md: '求 1+1',
              reference_md: '2',
              choices_md: null,
              rubric_json: {},
            },
          ],
        });
        expect(validation?.verdict).toBe('pass');
        return {
          text: '已创建并验证。',
          task_run_id: 'tr_durable_artifact_parent',
          finishReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );

    await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_durable_artifact_parent' },
      streamTaskCollectingFn: run as never,
      runValidationTaskFn: validationRunner as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
    });

    expect(validationRunner).toHaveBeenCalledTimes(4);
  });

  it('preserves the exact pre-ownership job payload shape', async () => {
    const oldPayload = {
      run_id: 'copilot_user_ask_old_payload',
      session_id: 'sess_old_payload',
      user_message: '核对旧投递在 worker 归属迁移后仍可执行。',
      triggered_by: 'chat',
    } satisfies CopilotRunJobData;
    const assembleSpy = vi.fn(stubRunInput);

    await runCopilotRun({
      db: testDb(),
      data: oldPayload,
      streamTaskCollectingFn: streamMock('旧投递已处理') as never,
      resolveCopilotRunInputFn: assembleSpy,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(Object.keys(oldPayload)).toEqual([
      'run_id',
      'session_id',
      'user_message',
      'triggered_by',
    ]);
    expect(assembleSpy.mock.calls[0]?.[1]).toEqual({
      sessionId: oldPayload.session_id,
      userMessage: oldPayload.user_message,
      triggeredBy: oldPayload.triggered_by,
      now: expect.any(Date),
      historyAnchorEventId: oldPayload.run_id,
    });
  });

  it('fails closed when a durable targeted correction omits its envelope', async () => {
    const targetId = 'copilot_reply_water_tank_durable';
    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: 'copilot_user_ask_target_without_envelope',
        session_id: 'sess_target_without_envelope',
        correction_target_turn_id: targetId,
      },
      streamTaskCollectingFn: streamMock('已把水箱题改正为 h*=4/9，k 不变。') as never,
      resolveCopilotRunInputFn: targetedRunInput(targetId),
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new TypeError('expected completed correction run');
    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).not.toContain('已把水箱题改正');
  });

  it('YUK-832 — raw evidence candidate stays private; repaired reply alone reaches delta, domain history, and terminal', async () => {
    const runId = 'copilot_user_ask_yuk832_durable_review';
    const sessionId = 'sess_yuk832_durable_review';
    const unsafeCandidate =
      '六个事件是连续且充分的因果链；C04 的 due query 返回 0 行，所以整个队列已归零。';
    const rawUnsafeCandidate = `${unsafeCandidate}\n<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_unsafe_durable"}}-->`;
    const safeReply =
      'evt_rate_a03 与 evt_probe_a03 只是 evt_proposal_a03 的直接子节点，不能串成兄弟因果链。C04 的 queue_assertion=null，无法裁决队列是否归零。';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'query_events',
          effect: 'read',
          input: { subject_id: 'diagnostic_subject_A03', limit: 50 },
          output: {
            query_contract: {
              scope_coverage: 'blocked_cross_subject_relation_followup_required',
            },
            events: [
              {
                id: 'evt_rate_a03',
                caused_by_event_id: 'evt_proposal_a03',
                evidence: { relation_type: 'direct_child' },
              },
              {
                id: 'evt_probe_a03',
                caused_by_event_id: 'evt_proposal_a03',
                outcome: null,
                evidence: {
                  outcome: 0,
                  activation_policy: 'not_observed',
                  necessary_conditions: 'not_supported',
                  sufficient_conditions: 'not_supported',
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          },
          error_reason: null,
          executed: true,
        });
        onDelta('六个事件是连续且充分的因果链；');
        onDelta('C04 返回 0 行，所以整个队列已归零。');
        expect(
          (await replay(runId)).some((event) => event.event_type === COPILOT_RUN_EVENTS.DELTA),
        ).toBe(false);
        return {
          text: rawUnsafeCandidate,
          task_run_id: 'tr_yuk832_durable_candidate',
          finishReason: 'end_turn',
          usage: { inputTokens: 132_000, outputTokens: 4_900 },
        };
      },
    );
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      expect(input).toMatchObject({
        candidateReply: unsafeCandidate,
        candidateComplete: true,
        requestContext: {
          user_message: expect.stringContaining('A03'),
          surface: 'copilot',
          triggered_by: 'chat',
        },
        toolTrace: [expect.objectContaining({ name: 'query_events', effect: 'read' })],
        attemptTimeouts: {
          referenceMs: COPILOT_DURABLE_EVIDENCE_REFERENCE_TIMEOUT_MS,
          comparisonMs: COPILOT_DURABLE_EVIDENCE_COMPARISON_TIMEOUT_MS,
        },
      });
      expect(input.requestContext).not.toHaveProperty('conversation_history');
      expect(
        (await replay(runId)).some((event) => event.event_type === COPILOT_RUN_EVENTS.DELTA),
      ).toBe(false);
      return {
        status: 'repair' as const,
        replyText: safeReply,
        reviewTaskRunId: 'tr_yuk832_durable_review',
        referenceTaskRunIds: ['tr_yuk832_durable_reference_invalid', 'tr_yuk832_durable_reference'],
        comparisonTaskRunIds: [
          'tr_yuk832_durable_original_rejected',
          'tr_yuk832_durable_fallback_pass_1',
          'tr_yuk832_durable_fallback_pass_2',
        ],
        violations: ['noncausal_relation', 'queue_or_count_unknown_promoted'],
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        user_message: '核完 A03 proposal→probe/review/judge 链，再判断 C04 due queue 是否归零。',
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({
      status: 'done',
      reply: safeReply,
      task_run_id: 'tr_yuk832_durable_candidate',
    });
    const events = await replay(runId);
    expect(events.map((entry) => entry.event_type)).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.DELTA)?.payload).toEqual({
      text: safeReply,
    });
    expect(
      events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.REPLY)?.payload,
    ).toMatchObject({
      reply_md: safeReply,
    });
    expect(JSON.stringify(events)).not.toContain(unsafeCandidate);
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.reply_md).toBe(safeReply);
    expect(replies[0]?.payload.evidence_validation).toEqual({
      status: 'repair',
      reference_task_run_ids: [
        'tr_yuk832_durable_reference_invalid',
        'tr_yuk832_durable_reference',
      ],
      comparison_task_run_ids: [
        'tr_yuk832_durable_original_rejected',
        'tr_yuk832_durable_fallback_pass_1',
        'tr_yuk832_durable_fallback_pass_2',
      ],
    });
    expect(JSON.stringify(replies[0])).not.toContain(unsafeCandidate);
    expect(replies[0]?.payload).not.toHaveProperty('primary_view');
  });

  it('YUK-839 — flash lane durable budgets: glm-5.3-flash evidence legs receive the burn-in-sized tier', async () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'zhipu');
    vi.stubEnv('AI_PROVIDER_MODEL', 'glm-5.3-flash');
    vi.stubEnv('ZHIPU_API_KEY', 'test-key-present');
    const runId = 'copilot_user_ask_yuk839_flash_budget';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, _onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'query_events',
          effect: 'read',
          input: { subject_id: 'diagnostic_subject_yuk839', limit: 10 },
          output: { events: [], has_more: false },
          error_reason: null,
          executed: true,
        });
        return {
          text: 'C04 的 queue_assertion=null，无法裁决队列是否归零。',
          task_run_id: 'tr_yuk839_flash_candidate',
          finishReason: 'end_turn',
          usage: { inputTokens: 9_000, outputTokens: 200 },
        };
      },
    );
    let capturedAttemptTimeouts: { referenceMs?: number; comparisonMs?: number } | undefined;
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      capturedAttemptTimeouts = input.attemptTimeouts;
      return {
        status: 'pass' as const,
        replyText: input.candidateReply,
        reviewTaskRunId: 'tr_yuk839_flash_reference',
        comparisonTaskRunIds: ['tr_yuk839_flash_comparison'],
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: 'sess_yuk839_flash_budget',
        user_message: '检查 C04 due queue 是否归零。',
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({
      status: 'done',
      reply: 'C04 的 queue_assertion=null，无法裁决队列是否归零。',
      task_run_id: 'tr_yuk839_flash_candidate',
    });
    expect(reviewEvidenceReplyFn).toHaveBeenCalledTimes(1);
    expect(capturedAttemptTimeouts).toEqual({
      referenceMs: 1_200_000,
      comparisonMs: 600_000,
    });
  });

  it('blocks unverified learning content introduced by a durable degraded blind reply', async () => {
    const runId = 'copilot_user_ask_durable_degraded_learning';
    const sessionId = 'sess_durable_degraded_learning';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, _onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'query_events',
          effect: 'read',
          input: { subject_id: 'durable_degraded_learning_subject' },
          output: { events: [], has_more: false },
          error_reason: null,
          executed: true,
        });
        return {
          text: '现有证据不足以判断队列是否清空。',
          task_run_id: 'tr_durable_degraded_learning',
          finishReason: 'end_turn',
          usage: { inputTokens: 8_000, outputTokens: 300 },
        };
      },
    );
    const unverifiedLearningReply = '题目：\n1. 请计算 23×29？';

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn: async () => ({
        status: 'degraded',
        replyText: unverifiedLearningReply,
      }),
    });

    expect(result).toMatchObject({
      status: 'done',
      reply: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY,
    });
    expect(JSON.stringify(await replay(runId))).not.toContain(unverifiedLearningReply);
    expect(JSON.stringify(await copilotReplyEvents(sessionId))).not.toContain(
      unverifiedLearningReply,
    );
  });

  it('rejects a durable evidence repair that drops the targeted correction binding', async () => {
    const runId = 'copilot_user_ask_correction_repair';
    const sessionId = 'sess_correction_repair';
    const targetId = 'copilot_reply_water_tank_durable_repair';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, _onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'query_events',
          effect: 'read',
          input: { subject_id: 'water_tank_d02' },
          output: { events: [], has_more: false },
          error_reason: null,
          executed: true,
        });
        return {
          text: `水箱更正后的推导。\n\n<!-- copilot-correction {"prior_turn_id":"${targetId}","changed":["h*=4/9"],"retained":["同一个 k"],"uncertain":[]} -->`,
          task_run_id: 'tr_correction_repair',
          finishReason: 'end_turn',
          usage: { inputTokens: 1_000, outputTokens: 200 },
        };
      },
    );
    const unsafeRepair = '证据修复后的正文，但没有 correction envelope。';

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        correction_target_turn_id: targetId,
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: targetedRunInput(targetId),
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn: async () => ({ status: 'repair', replyText: unsafeRepair }),
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new TypeError('expected completed correction repair');
    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).not.toContain(unsafeRepair);
  });

  it('rejects a durable degraded blind reply that drops the targeted correction binding', async () => {
    const runId = 'copilot_user_ask_correction_degraded';
    const sessionId = 'sess_correction_degraded';
    const targetId = 'copilot_reply_water_tank_durable_degraded';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, _onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'query_events',
          effect: 'read',
          input: { subject_id: 'water_tank_d02' },
          output: { events: [], has_more: false },
          error_reason: null,
          executed: true,
        });
        return {
          text: `水箱更正后的推导。\n\n<!-- copilot-correction {"prior_turn_id":"${targetId}","changed":["h*=4/9"],"retained":["同一个 k"],"uncertain":[]} -->`,
          task_run_id: 'tr_correction_degraded',
          finishReason: 'end_turn',
          usage: { inputTokens: 1_000, outputTokens: 200 },
        };
      },
    );
    const unboundDegradedReply = '盲审替换正文，但没有 correction envelope。';

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        correction_target_turn_id: targetId,
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: targetedRunInput(targetId),
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn: async () => ({
        status: 'degraded',
        replyText: unboundDegradedReply,
      }),
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new TypeError('expected completed correction degradation');
    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).not.toContain(unboundDegradedReply);
  });

  it('YUK-832 — read-bearing partial keeps the real primary run id on its reviewed failure marker', async () => {
    const runId = 'copilot_user_ask_yuk832_reviewed_partial';
    const sessionId = 'sess_yuk832_reviewed_partial';
    const primaryTaskRunId = 'tr_yuk832_reviewed_partial_primary';
    const unsafePartial =
      '42 次作答与 5 个探针已经证明定义域错误是唯一根因，而且 due reader 返回 0 行证明整个队列清空。';
    const safePartial =
      '42 次作答只支持定义域错误反复出现；5 个探针尚未全部完成。due reader 的 exact filter 返回 0 行，但完整队列覆盖仍未知。';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'get_review_due',
          effect: 'read',
          input: { learner_id: 'learner_complex_42', limit: 100 },
          output: {
            rows: [],
            queue_assertion: { cleared: null },
            queue_coverage: {
              completeness: 'unknown',
              supports_exhaustive_zero_claim: false,
            },
          },
          error_reason: null,
          executed: true,
        });
        onDelta(unsafePartial);
        return {
          text: unsafePartial,
          task_run_id: primaryTaskRunId,
          finishReason: 'tool_budget_exhausted',
          usage: { inputTokens: 71_000, outputTokens: 2_300 },
          partial: true,
          error: 'provider budget exhausted after five cross-domain probes',
        };
      },
    );
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      expect(input).toMatchObject({
        candidateReply: unsafePartial,
        candidateTaskRunId: primaryTaskRunId,
        candidateComplete: false,
        toolTrace: [expect.objectContaining({ name: 'get_review_due', effect: 'read' })],
      });
      return {
        status: 'repair' as const,
        replyText: safePartial,
        referenceTaskRunIds: ['tr_yuk832_partial_reference'],
        comparisonTaskRunIds: [
          'tr_yuk832_partial_original_fail',
          'tr_yuk832_partial_repair_pass_1',
          'tr_yuk832_partial_repair_pass_2',
        ],
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        user_message:
          '交叉核验 42 次作答、5 个未教学探针与完整 due queue，再判断定义域错误是否为唯一根因。',
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({
      status: 'failed',
      error: 'provider budget exhausted after five cross-domain probes',
    });
    const events = await replay(runId);
    expect(events.map((entry) => entry.event_type)).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.DELTA)?.payload).toEqual({
      text: safePartial,
    });
    expect(
      events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.FAILED)?.payload,
    ).toMatchObject({
      reason: 'exhausted',
      reply_md: safePartial,
    });
    expect(JSON.stringify(events)).not.toContain(unsafePartial);

    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      outcome: 'failure',
      task_run_id: primaryTaskRunId,
      payload: {
        reply_md: safePartial,
        evidence_validation: {
          status: 'repair',
          reference_task_run_ids: ['tr_yuk832_partial_reference'],
          comparison_task_run_ids: [
            'tr_yuk832_partial_original_fail',
            'tr_yuk832_partial_repair_pass_1',
            'tr_yuk832_partial_repair_pass_2',
          ],
        },
      },
    });
    expect(JSON.stringify(replies)).not.toContain(unsafePartial);
  });

  it('YUK-832 — durable pass projects exact bytes and drops an unreviewed primary-view side channel', async () => {
    const runId = 'copilot_user_ask_yuk832_durable_exact_bytes';
    const sessionId = 'sess_yuk832_durable_exact_bytes';
    const cleanedCandidate =
      'A03 的 probe 与 rate 都是 proposal 的直接子事件；现有记录不支持把兄弟事件串成因果链。';
    const marker = '<!--primary_view:{"source":"ephemeral_html","ref":"<div>队列已清空</div>"}-->';
    const rawCandidate = `${cleanedCandidate}\n${marker}`;
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'query_events',
          effect: 'read',
          input: { subject_id: 'diagnostic_subject_A03', limit: 50 },
          output: {
            events: [
              { id: 'evt_probe', caused_by_event_id: 'evt_proposal' },
              { id: 'evt_rate', caused_by_event_id: 'evt_proposal' },
            ],
            has_more: false,
          },
          error_reason: null,
          executed: true,
        });
        onDelta(cleanedCandidate.slice(0, 18));
        onDelta(`${cleanedCandidate.slice(18)}\n${marker}`);
        return {
          text: rawCandidate,
          task_run_id: 'tr_yuk832_durable_exact_bytes',
          finishReason: 'end_turn',
          usage: { inputTokens: 18_500, outputTokens: 730 },
        };
      },
    );
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      expect(input.candidateReply).toBe(cleanedCandidate);
      return {
        status: 'pass' as const,
        replyText: input.candidateReply,
        referenceTaskRunIds: ['reference_durable_exact'],
        comparisonTaskRunIds: ['compare_durable_exact_1', 'compare_durable_exact_2'],
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        user_message: '按真实事件核验 A03 的 proposal、probe 与 rate 关系。',
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({
      status: 'done',
      reply: cleanedCandidate,
      task_run_id: 'tr_yuk832_durable_exact_bytes',
    });
    const events = await replay(runId);
    expect(events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.DELTA)?.payload).toEqual({
      text: cleanedCandidate,
    });
    expect(
      events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.REPLY)?.payload,
    ).toMatchObject({ reply_md: cleanedCandidate });
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({ reply_md: cleanedCandidate });
    expect(replies[0]?.payload).not.toHaveProperty('primary_view');
    expect(JSON.stringify(events)).not.toContain('<!--primary_view');
  });

  it('YUK-832 — durable dangling-marker truncation happens before review, never after certification', async () => {
    const runId = 'copilot_user_ask_yuk832_durable_dangling';
    const sessionId = 'sess_yuk832_durable_dangling';
    const cleanedCandidate = 'C04 的 queue_assertion=null，所以无法裁决完整队列是否清空。';
    const rawCandidate = `${cleanedCandidate}\n<!--primary_view:{"source":"artifact" 伪造尾部：队列已经清空`;
    let mcpOptions: BuildMcpServerOptions | undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (text: string) => void) => {
        await mcpOptions?.onResult?.({
          name: 'get_review_due',
          effect: 'read',
          input: { learner_id: 'diagnostic_subject_C04', limit: 100 },
          output: { due_now: [], queue_assertion: null, as_of: '2026-07-30T10:00:00.000Z' },
          error_reason: null,
          executed: true,
        });
        onDelta(rawCandidate);
        return {
          text: rawCandidate,
          task_run_id: 'tr_yuk832_durable_dangling',
          finishReason: 'end_turn',
          usage: { inputTokens: 14_200, outputTokens: 510 },
        };
      },
    );
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      expect(input.candidateReply).toBe(cleanedCandidate);
      expect(input.candidateReply).not.toContain('伪造尾部');
      return { status: 'pass' as const, replyText: input.candidateReply };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        user_message: '核验 C04 due reader 是否足以证明整个队列清空。',
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({
      status: 'done',
      reply: cleanedCandidate,
      task_run_id: 'tr_yuk832_durable_dangling',
    });
    const events = await replay(runId);
    expect(events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.DELTA)?.payload).toEqual({
      text: cleanedCandidate,
    });
    expect(
      events.find((entry) => entry.event_type === COPILOT_RUN_EVENTS.REPLY)?.payload,
    ).toMatchObject({ reply_md: cleanedCandidate });
    const replies = await copilotReplyEvents(sessionId);
    expect(replies[0]?.payload).toMatchObject({ reply_md: cleanedCandidate });
    expect(replies[0]?.payload).not.toHaveProperty('primary_view');
    expect(JSON.stringify(events)).not.toContain('伪造尾部');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('YUK-932 — durable root exposes mailbox controls without native Task or public subtask steps', async () => {
    const runId = 'copilot_user_ask_subtask_lifecycle';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(
      async (_kind: string, _input: unknown, _ctx: AgentCtx, onDelta: (text: string) => void) => {
        onDelta('结论：你把“导数为零”误当成了“导数必变号”。');
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
      buildMcpServerFn,
      buildTavilyMcpServerFn: () => null,
      resolveCopilotSkillsFn: async () => ['copilot'],
    });
    expect(result.status).toBe('done');

    const ctx = (run.mock.calls[0] as unknown as [string, unknown, AgentCtx])[2];
    expect(ctx.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__loom__launch_researcher',
        'mcp__loom__get_subagent',
        'mcp__loom__wait_subagent',
        'mcp__loom__cancel_subagent',
      ]),
    );
    expect(ctx.allowedTools).not.toContain('Task');
    expect(ctx).not.toHaveProperty('agents');
    expect(ctx).not.toHaveProperty('canUseTool');
    expect(ctx).not.toHaveProperty('onTaskEvent');
    expect(ctx.hooks?.PreToolUse).toHaveLength(2);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(mcpOptions?.ctx.sessionId).toBe('sess_durable_subtasks');
    expect(mcpOptions?.cancellationSignals).toHaveLength(2);
    expect(mcpOptions?.cancellationSignals?.map((entry) => entry.requestedBy)).toEqual([
      'system',
      'user',
    ]);
    const correlationHook = ctx.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    await correlationHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk-durable-session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'mcp__loom__search_memory_facts',
        tool_input: { query: 'durable correlation', topK: 9 },
        tool_use_id: 'toolu_durable_real_9',
      },
      'toolu_durable_real_9',
      { signal: new AbortController().signal },
    );
    expect(
      mcpOptions?.claimToolUseId?.('search_memory_facts', {
        topK: 9,
        query: 'durable correlation',
      }),
    ).toBe('toolu_durable_real_9');
    const events = await replay(runId);
    expect(events.map((event) => event.event_type)).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(events.some((event) => event.event_type === COPILOT_RUN_EVENTS.STEP)).toBe(false);
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
    expect(ctx.hooks?.PreToolUse).toHaveLength(2);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
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
      deltas: ['已核对 42 次作答；', '三轮延迟复习与五个探针也已完成。'],
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
        durable_emit_reviewed_delta: true,
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
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.REPLY,
      COPILOT_RUN_EVENTS.DONE,
    ]);
    expect(repairedEvents.filter((item) => item.event_type === COPILOT_RUN_EVENTS.DELTA)).toEqual([
      expect.objectContaining({ payload: { text: reply } }),
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
      deltas: ['已完成 42 次历史作答核对；', '五个探针只跑完三题。'],
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
      task_run_id: 'tr_failed_projection_repair',
      caused_by_event_id: runId,
      payload: {
        reply_md: partialReply,
        durable_emit_reviewed_delta: true,
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
      COPILOT_RUN_EVENTS.DELTA,
      COPILOT_RUN_EVENTS.FAILED,
    ]);
    expect(repairedEvents.filter((item) => item.event_type === COPILOT_RUN_EVENTS.DELTA)).toEqual([
      expect.objectContaining({ payload: { text: partialReply } }),
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
      .set({ occurred_at: new Date(Date.now() - DURABLE_OWNER_SETTLEMENT_BUDGET_MS - 1_000) })
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

    // A genuine recovery happens only after the 12-minute primary run, bounded
    // final evidence review, and settlement grace have elapsed. Age the fence
    // rather than mis-model an early overlap as a crashed owner.
    await testDb()
      .update(job_events)
      .set({
        occurred_at: new Date(Date.now() - DURABLE_OWNER_SETTLEMENT_BUDGET_MS - 1_000),
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

  // YUK-575/YUK-832 (N2/S3) — 原始 chunks 只作“有正文”信号；review 后的完整安全
  // DELTA 与 terminal 在同一 settlement transaction 内写入，保证可恢复且 id 单调。
  it('N2/S3 — one reviewed full-text DELTA 严格早于 REPLY/DONE', async () => {
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
    // 事件序列：STARTED, EXECUTION_STARTED, reviewed full DELTA, REPLY, DONE。
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      COPILOT_RUN_EVENTS.STARTED,
      COPILOT_RUN_EVENTS.EXECUTION_STARTED,
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
    // delta payload 是审阅后的完整正文，不重放 raw chunk 边界。
    const firstDelta = events.find((e) => e.event_type === COPILOT_RUN_EVENTS.DELTA);
    expect(firstDelta?.payload).toMatchObject({ text: '最终答复' });
    // 流式态派生为 running（终态 done 前）。
    expect(deriveCopilotRunStatus(events.slice(0, 3))).toBe('running');
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
    expect(ctx.providerSessionDeadlineAt).toBeUndefined();
    expect(ctx.sdkSession).toBeUndefined();
    // MF-A + YUK-290：25 只是 warning，60 才是 hard ceiling。
    const opts = (
      buildMcp.mock.calls[0] as unknown as [
        {
          ctx: { signal?: AbortSignal };
          beforeExecute: (t: unknown) => Promise<string | undefined>;
          interceptInput: (t: unknown, args: unknown) => { truncationNote?: object | null };
        },
      ]
    )[0];
    expect(ctx.lifecycleAbortController).toBeInstanceOf(AbortController);
    expect(opts.ctx.signal).toBe(ctx.lifecycleAbortController?.signal);
    const fakeTool = { name: 'query_knowledge', effect: 'read' };
    for (let i = 0; i < 25; i++)
      await expect(opts.beforeExecute(fakeTool)).resolves.toBeUndefined();
    expect(opts.interceptInput(fakeTool, {}).truncationNote).toMatchObject({
      level: 'warning',
      dimensions: { toolCalls: { used: 25, hard_remaining: 35 } },
    });
    for (let i = 25; i < 60; i++)
      await expect(opts.beforeExecute(fakeTool)).resolves.toBeUndefined();
    await expect(opts.beforeExecute(fakeTool)).resolves.toMatch(/hard context budget reached/);
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
    expect(DURABLE_OWNER_SETTLEMENT_BUDGET_MS).toBe(
      DURABLE_BUDGET.timeoutMs +
        COPILOT_DURABLE_EVIDENCE_REVIEW_TOTAL_TIMEOUT_MS +
        CLAIMED_EXECUTION_SETTLE_GRACE_MS,
    );
    expect(DURABLE_BUDGET.timeoutMs).toBeLessThan(STUCK_RUN_THRESHOLD_MS);
    expect(DURABLE_OWNER_SETTLEMENT_BUDGET_MS).toBeLessThan(STUCK_RUN_THRESHOLD_MS);
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
    const buildMcpServer = mcpMock();
    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: buildMcpServer as never,
    });
    expect(result).toMatchObject({ status: 'done', reply: '重试成功的回答' });
    expect(run).toHaveBeenCalledTimes(1);
    const retryTaskRunId = `copilot_run_tool_${runId}_retry_1`;
    expect(run.mock.calls[0]?.[2]).toMatchObject({ taskRunId: retryTaskRunId });
    expect(buildMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ taskRunId: retryTaskRunId }),
      }),
    );
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

  it('YUK-842 — a second durable retry acquires and starts a fresh attempt without reopening either prior ledger', async () => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
    vi.stubEnv('AI_PROVIDER_SESSION_ADMISSION_MODE', 'enforce');
    vi.stubEnv(
      'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON',
      JSON.stringify({
        xiaomi: {
          maxConcurrentSessions: 4,
          maxSessionStartsPerMinute: 30,
          maxQueuedSessions: 8,
          maxWaitMs: 2_000,
        },
      }),
    );

    const runId = 'run_second_retry_fresh_attempt';
    const baseTaskRunId = `copilot_run_tool_${runId}`;
    const firstRetryTaskRunId = `${baseTaskRunId}_retry_1`;
    const secondRetryTaskRunId = `${baseTaskRunId}_retry_2`;
    const admissionPlan = resolveProviderSessionAdmissionPlan('xiaomi');
    if (admissionPlan.mode !== 'enforce') throw new Error('expected enforce admission plan');

    const seedTerminalAttempt = async (taskRunId: string) => {
      await testDb()
        .insert(ai_task_runs)
        .values({
          id: taskRunId,
          task_kind: 'CopilotTask',
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro',
          input_hash: `legacy:${taskRunId}`,
          status: 'failure',
          finish_reason: 'error',
          usage_json: { inputTokens: 1, outputTokens: 0 },
          error_message: 'legacy retryable failure',
          started_at: new Date('2026-08-02T00:00:00.000Z'),
          finished_at: new Date('2026-08-02T00:00:01.000Z'),
        });
      const controller = new AbortController();
      const permit = await acquireProviderSession({
        db: testDb(),
        kind: 'CopilotTask',
        taskRunId,
        executionTimeoutMs: 1_000,
        signal: controller.signal,
        plan: admissionPlan,
        onLeaseLost: () => controller.abort(),
      });
      await permit.release();
    };
    await seedTerminalAttempt(baseTaskRunId);
    await seedTerminalAttempt(firstRetryTaskRunId);
    for (const error of ['first provider failure', 'second provider failure']) {
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'error', error },
      });
    }

    const buildMcpServer = mcpMock();
    const run = vi.fn(async (_kind: string, input: unknown, ctx: AgentCtx) => {
      const lifecycle = createRunLifecycle({
        db: ctx.db as Db,
        kind: 'CopilotTask',
        taskRunId: ctx.taskRunId,
        timeoutMs: 1_000,
        abortController: ctx.lifecycleAbortController,
        signal: ctx.signal,
        logScope: 'copilot-retry-admission-test',
      });
      try {
        await lifecycle.withProviderSession(input, {
          prepare: async () => {},
          run: async () => {
            lifecycle.recordTerminalResult({
              usage: { inputTokens: 2, outputTokens: 1 },
              tokenCounts: { inputTokens: 2, outputTokens: 1 },
              finishReason: 'end_turn',
            });
          },
          close: async () => {},
        });
        const result = {
          task_run_id: lifecycle.taskRunId,
          text: '第二次重试成功',
          finishReason: lifecycle.finishReason,
          usage: lifecycle.usage,
          cost_usd: lifecycle.costUsd,
          cost_basis: lifecycle.costBasis,
          cost_ref: lifecycle.costRef,
        };
        await lifecycle.finishSuccess(result);
        return result;
      } finally {
        lifecycle.dispose();
      }
    });

    await expect(
      runCopilotRun({
        db: testDb(),
        data: { ...baseData, run_id: runId, session_id: 'sess_second_retry_fresh_attempt' },
        streamTaskCollectingFn: run as never,
        resolveCopilotRunInputFn: stubRunInput,
        buildMcpServerFn: buildMcpServer as never,
      }),
    ).resolves.toMatchObject({ status: 'done', task_run_id: secondRetryTaskRunId });
    expect(run.mock.calls[0]?.[2]).toMatchObject({ taskRunId: secondRetryTaskRunId });
    expect(buildMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ taskRunId: secondRetryTaskRunId }),
      }),
    );

    for (const taskRunId of [baseTaskRunId, firstRetryTaskRunId]) {
      const [attempt] = await testDb()
        .select({ status: ai_task_runs.status, finishReason: ai_task_runs.finish_reason })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, taskRunId));
      const [admission] = await testDb()
        .select({ status: provider_session_admission.status })
        .from(provider_session_admission)
        .where(eq(provider_session_admission.task_run_id, taskRunId));
      expect(attempt).toEqual({ status: 'failure', finishReason: 'error' });
      expect(admission).toEqual({ status: 'released' });
    }
    const [retriedAttempt] = await testDb()
      .select({ status: ai_task_runs.status })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, secondRetryTaskRunId));
    const [retriedAdmission] = await testDb()
      .select({ status: provider_session_admission.status })
      .from(provider_session_admission)
      .where(eq(provider_session_admission.task_run_id, secondRetryTaskRunId));
    expect(retriedAttempt).toEqual({ status: 'success' });
    expect(retriedAdmission).toEqual({ status: 'released' });
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

  it('Stop — pure-text long run aborts from persisted cancellation, preserves rich partial output, and emits one cancelled terminal', async () => {
    const runId = 'copilot_user_ask_stop_48_answers_6_probes_3_docs_9_transfers';
    const sessionId = 'sess_stop_pure_text_cross_subject';
    const partialReply =
      '已完成 48 条历史回答的三科交叉聚类，并核验 3 份讲义中的定义域、方向与量纲；6 个薄弱点探针已确认 4 个，9 个迁移变式尚未开始物化。';
    const run = vi.fn(
      async (_kind: string, input: unknown, ctx: AgentCtx, onDelta: (text: string) => void) => {
        expect(input).toMatchObject({
          evidence_shape: {
            answer_count: 48,
            probe_count: 6,
            source_document_count: 3,
            transfer_variant_count: 9,
          },
        });
        onDelta(partialReply);
        await writeJobEvent(testDb(), {
          business_table: COPILOT_RUN_TABLE,
          business_id: runId,
          event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
          payload: { requested_by: 'user', stage: 'after_fourth_probe' },
        });
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) resolve();
          else ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          text: partialReply,
          task_run_id: 'tr_stop_pure_text_cross_subject',
          finishReason: 'error',
          usage: { inputTokens: 18_400, outputTokens: 1_320 },
          partial: true,
          error: 'root SDK loop aborted after Stop',
        };
      },
    );
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
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: richInput as never,
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    const events = await replay(runId);
    expect(events.filter((event) => event.event_type === COPILOT_RUN_EVENTS.FAILED)).toHaveLength(
      1,
    );
    expect(events.some((event) => event.event_type === COPILOT_RUN_EVENTS.DONE)).toBe(false);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: 'cancelled',
      reply_md: partialReply,
      checkpoint_event_id: runId,
    });
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      outcome: 'failure',
      task_run_id: 'tr_stop_pure_text_cross_subject',
      payload: {
        reply_md: partialReply,
        durable_failure: { reason: 'cancelled' },
      },
    });
  });

  it('Stop — aborts validator provider calls through the durable cancellation signal', async () => {
    const runId = 'copilot_user_ask_stop_during_learning_validation';
    const controller = new AbortController();
    const observedValidatorSignals: boolean[] = [];
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const cancellationControl = {
      signal: controller.signal,
      hasConfirmedCancellation: false,
      materializingToolStarted: false,
      startPolling: vi.fn(),
      dispose: vi.fn(),
      probe: vi.fn(async () => (controller.signal.aborted ? 'cancel_requested' : 'clear')),
      beforeTool: vi.fn(async () => undefined),
      onToolExecutionStarted: vi.fn(),
      onToolExecutionSettled: vi.fn(),
      waitForInFlight: vi.fn(async () => true),
      prependSdkHook: vi.fn((hooks) => hooks ?? { PreToolUse: [] }),
    };
    const validationRunner = vi.fn(async (kind: string, _input: unknown, ctx: AgentCtx) => {
      markProviderStarted?.();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        else ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      observedValidatorSignals.push(ctx.signal?.aborted === true);
      if (kind === 'QuizVerifyTask') {
        return {
          task_run_id: 'verify-stop',
          text: JSON.stringify({
            grounding: { verdict: 'pass', reason: 'self-contained' },
            copy_safety: { verdict: 'original', max_overlap: 0 },
            knowledge_hit: { verdict: 'pass', reason: 'on topic' },
            overall: 'pass',
            summary_md: 'pass',
            confidence: 0.99,
          }),
        };
      }
      if (kind === 'SolutionGenerateTask') {
        return {
          task_run_id: 'solve-stop',
          text: JSON.stringify({
            reference_solution: {
              final_answer: '2',
              expected_signals: ['1+1'],
              answer_equivalents: [],
            },
            worked_solution_md: '1+1=2',
            confidence: 0.99,
          }),
        };
      }
      if (kind === 'SemanticJudgeTask') {
        return {
          task_run_id: 'judge-stop',
          text: JSON.stringify({
            score: 1,
            coarse_outcome: 'correct',
            confidence: 0.99,
            feedback_md: 'pass',
            evidence_json: { matched_points: ['1+1=2'], missing_points: [] },
          }),
        };
      }
      return {
        task_run_id: 'teaching-stop',
        text: JSON.stringify({
          clarity: { verdict: 'pass', reason: 'clear' },
          unique_answer: { verdict: 'pass', reason: 'unique' },
          summary: 'pass',
        }),
      };
    });
    const candidate =
      '题目\n1. 求 1+1？\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1？","reference_md":"2","choices_md":null,"rubric_json":{}}]}-->';

    const runPromise = runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: 'sess_stop_learning_validation' },
      streamTaskCollectingFn: streamMock(candidate) as never,
      runValidationTaskFn: validationRunner as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      createCancellationControlFn: (() => cancellationControl) as never,
    });
    await providerStarted;
    controller.abort(new Error('user requested Stop during learning validation'));
    const result = await runPromise;

    expect(result).toEqual({ status: 'cancelled' });
    expect(observedValidatorSignals.length).toBeGreaterThan(0);
    expect(observedValidatorSignals.every(Boolean)).toBe(true);
  });

  it('Stop — validates a targeted correction before persisting its cancellation partial', async () => {
    const runId = 'copilot_user_ask_stop_targeted_without_envelope';
    const sessionId = 'sess_stop_targeted_without_envelope';
    const targetId = 'copilot_reply_water_tank_cancelled';
    const unsafeReply = '已把水箱题改正为 h*=4/9，但没有 correction envelope。';
    const run = vi.fn(async () => {
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { requested_by: 'user', stage: 'after_model_reply' },
      });
      return {
        text: unsafeReply,
        task_run_id: 'tr_stop_targeted_without_envelope',
        finishReason: 'error',
        usage: { inputTokens: 1_200, outputTokens: 90 },
        partial: true,
        error: 'cancelled after model reply',
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: {
        ...baseData,
        run_id: runId,
        session_id: sessionId,
        correction_target_turn_id: targetId,
      },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: targetedRunInput(targetId),
      buildMcpServerFn: mcpMock() as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    const events = await replay(runId);
    const failed = events.find((event) => event.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({
      reason: 'cancelled',
      reply_md: expect.stringContaining('上一轮是「水箱 D02：原推导用了错误高度。」'),
    });
    expect(failed?.payload).not.toMatchObject({ reply_md: unsafeReply });
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.reply_md).not.toBe(unsafeReply);
  });

  it('Stop — read-bearing cancellation after certification persists neither candidate nor selected repair', async () => {
    const runId = 'copilot_user_ask_stop_between_certification_and_marker';
    const sessionId = 'sess_stop_between_certification_and_marker';
    const unsafeCandidate = 'exact subjectId 里是 0，所以产品数据库不存在 intervention。';
    const selectedRepair = '本轮 subjectId 窗口未返回 intervention，但完整因果后段仍未核验。';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcp = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(async () => {
      await mcpOptions?.onResult?.({
        name: 'query_events',
        effect: 'read',
        input: { filter: { subjectId: 'kc_chain_rule', limit: 50 } },
        output: {
          events: [],
          subject_scope: {
            causal_descendants_included: false,
            cross_stage_claim_status: 'blocked_cross_subject_relation_followup_required',
          },
        },
        error_reason: null,
        executed: true,
      });
      return {
        text: unsafeCandidate,
        task_run_id: 'tr_stop_between_certification_and_marker',
        finishReason: 'end_turn',
        usage: { inputTokens: 12_000, outputTokens: 600 },
      };
    });
    const reviewEvidenceReplyFn = vi.fn(async () => {
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { requested_by: 'user', stage: 'after_certification_before_marker' },
      });
      return {
        status: 'repair' as const,
        replyText: selectedRepair,
        reviewTaskRunId: 'tr_review_before_stop',
        verificationTaskRunId: 'tr_certification_before_stop',
        violations: ['incomplete_scope_or_pagination'],
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: buildMcp as never,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({ status: 'cancelled' });
    const serialized = JSON.stringify(await replay(runId));
    expect(serialized).not.toContain(unsafeCandidate);
    expect(serialized).not.toContain(selectedRepair);
    const replies = await copilotReplyEvents(sessionId);
    expect(JSON.stringify(replies)).not.toContain(unsafeCandidate);
    expect(JSON.stringify(replies)).not.toContain(selectedRepair);
  });

  it('Stop — pure-text cancellation observed after review preserves the reviewed partial', async () => {
    const runId = 'copilot_user_ask_stop_after_pure_text_review';
    const sessionId = 'sess_stop_after_pure_text_review';
    const reviewedPartial =
      '已完成三份材料的前两份对照：定义域约束一致，第二份在参数退化处多一个边界分支；第三份尚未完成。';
    const run = vi.fn(async () => ({
      text: reviewedPartial,
      task_run_id: 'tr_stop_after_pure_text_review',
      finishReason: 'end_turn',
      usage: { inputTokens: 8_000, outputTokens: 420 },
    }));
    const reviewEvidenceReplyFn = vi.fn(async () => {
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { requested_by: 'user', stage: 'after_pure_text_review' },
      });
      return { status: 'skipped' as const, replyText: reviewedPartial };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      reviewEvidenceReplyFn,
    });

    expect(result).toEqual({ status: 'cancelled' });
    const events = await replay(runId);
    expect(events.at(-1)?.payload).toMatchObject({
      reason: 'cancelled',
      reply_md: reviewedPartial,
    });
    expect(await copilotReplyEvents(sessionId)).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        task_run_id: 'tr_stop_after_pure_text_review',
        payload: expect.objectContaining({
          reply_md: reviewedPartial,
          durable_failure: expect.objectContaining({ reason: 'cancelled' }),
        }),
      }),
    ]);
  });

  it('Stop — a materializing tool start suppresses the checkpoint even when its mirror is unavailable', async () => {
    const runId = 'copilot_user_ask_stop_during_author_question';
    const sessionId = 'sess_stop_materializing_without_mirror';
    let mcpOptions:
      | {
          beforeExecute: (tool: { name: string; effect: 'write' }) => Promise<string | undefined>;
          onExecuteStart: (tool: { name: string; effect: 'write' }) => void;
          onExecuteSettled: () => void;
        }
      | undefined;
    const buildMcp = vi.fn((options: NonNullable<typeof mcpOptions>) => {
      mcpOptions = options;
      return { type: 'sdk', name: DOMAIN_TOOL_MCP_SERVER_NAME } as never;
    });
    const run = vi.fn(async (_kind: string, _input: unknown, ctx: AgentCtx) => {
      const tool = { name: 'author_question', effect: 'write' as const };
      await expect(mcpOptions?.beforeExecute(tool)).resolves.toBeUndefined();
      mcpOptions?.onExecuteStart(tool);
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { requested_by: 'user', stage: 'authoring_unique_solution_transfer' },
      });
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        else ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      // Simulate the domain write/log completing while the tool_use mirror is
      // unavailable. The runtime latch must still fail closed for checkpoint safety.
      mcpOptions?.onExecuteSettled();
      return {
        text: '已完成题干骨架，但尚未完成 9 个迁移变式的唯一解复核。',
        task_run_id: 'tr_stop_materializing_without_mirror',
        finishReason: 'error',
        usage: { inputTokens: 22_000, outputTokens: 1_800 },
        partial: true,
        error: 'cancelled during author_question',
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: buildMcp as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    const events = await replay(runId);
    const failed = events.find((event) => event.event_type === COPILOT_RUN_EVENTS.FAILED);
    expect(failed?.payload).toMatchObject({ reason: 'cancelled' });
    expect(failed?.payload).not.toHaveProperty('checkpoint_event_id');
    const replies = await copilotReplyEvents(sessionId);
    expect(replies[0]?.payload).toMatchObject({
      durable_failure: { reason: 'cancelled', checkpoint_safe: false },
    });
    expect(replies[0]?.task_run_id).toBe('tr_stop_materializing_without_mirror');
    expect(
      await testDb()
        .select({ id: event.id })
        .from(event)
        .where(and(eq(event.action, 'tool_use'), eq(event.caused_by_event_id, runId))),
    ).toEqual([]);
  });

  it('Stop — a cancellation committed before settlement wins over an SDK success result', async () => {
    const runId = 'copilot_user_ask_cancel_vs_success_settlement';
    const sessionId = 'sess_cancel_vs_success_settlement';
    const owner = new AbortController();
    const fakeControl = {
      signal: owner.signal,
      hasConfirmedCancellation: false,
      materializingToolStarted: false,
      startPolling() {},
      dispose() {},
      probe: async () => 'clear' as const,
      beforeTool: async () => undefined,
      onToolExecutionStarted() {},
      onToolExecutionSettled() {},
      waitForInFlight: async () => true,
      prependSdkHook: () => ({ PreToolUse: [] }),
    };
    const successText = '48 条历史回答、6 个探针、3 份讲义与 9 个迁移变式已经全部处理完毕。';
    const run = vi.fn(async () => {
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { requested_by: 'user', stage: 'settlement_race' },
      });
      return {
        text: successText,
        task_run_id: 'tr_cancel_vs_success_settlement',
        finishReason: 'end_turn',
        usage: { inputTokens: 24_000, outputTokens: 2_400 },
      };
    });

    const result = await runCopilotRun({
      db: testDb(),
      data: { ...baseData, run_id: runId, session_id: sessionId },
      streamTaskCollectingFn: run as never,
      resolveCopilotRunInputFn: stubRunInput,
      buildMcpServerFn: mcpMock() as never,
      createCancellationControlFn: (() => fakeControl) as never,
    });

    expect(result).toEqual({ status: 'cancelled' });
    const events = await replay(runId);
    expect(events.some((event) => event.event_type === COPILOT_RUN_EVENTS.DONE)).toBe(false);
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'cancelled' });
    const replies = await copilotReplyEvents(sessionId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      outcome: 'failure',
      task_run_id: 'tr_cancel_vs_success_settlement',
      payload: { durable_failure: { reason: 'cancelled' } },
    });
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

  it('缺字段的 job 抛给 pg-boss 保留 retry/failed 证据，不写事件、不调 AI', async () => {
    const db = testDb();
    const handler = buildCopilotRunHandler(db);
    await expect(
      handler([
        { id: 'j2', data: { run_id: '', user_message: '', triggered_by: 'chat' } },
        { id: 'j3', data: undefined },
      ] as never),
    ).rejects.toThrow(/missing run_id\/session_id\/user_message\/triggered_by/);
    const skipped = await computeReplay(db, {
      businessTable: COPILOT_RUN_TABLE,
      businessId: '',
      lastEventId: 0,
    });
    expect(skipped).toHaveLength(0);
  });
});
