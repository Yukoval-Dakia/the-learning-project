// YUK-364 (ADR-0041 endurance W1 L2) — durable copilot run handler。
//
// 把 copilot 从同步面（src/capabilities/copilot/server/chat.ts 的 inline
// streamTaskCollecting）桥到异步 durable pg-boss 面：route dispatch（durable
// 标记）→ boss.send('copilot_run', {...}) → 本 handler 在 worker 进程跑一个
// CopilotTask run，边跑边把进度/终稿写进 job_events，SSE 消费者经 computeReplay
// 订阅（消费端 UI 是后续 lane）。
//
// 蓝本：src/server/boss/handlers/quiz_gen.ts 的 runQuizGen——MCP mount
// (buildMcpServerFromRegistry) + ToolContext(causedByEventId=triggerEventId) +
// runAgentTask + 成功/失败 writeEvent。差别：本 handler 走 CopilotTask + copilot
// 工具全集 surface，进度落 job_events（writeJobEvent）而非 domain event 表，
// 不新增表（run handle = run_id = checkpoint_id = user_ask event id；状态从
// computeReplay 末事件派生，见 copilot-run-status.ts）。
//
// worker 零前置（grounding 2026-06-15，覆盖分支上 stale ADR §代价）：worker 每个
// AI job 经 buildMcpServerFromRegistry，其幂等 registerCoreTools() 把 CORE_TOOLS
// 全集填进本进程 registry，是 manifest union 的真超集 → 本 handler 走
// buildMcpServerFromRegistry 自动有 copilot 全集工具。不碰 start-worker.ts。

import type { Job } from 'pg-boss';

import { writeCopilotReply } from '@/capabilities/copilot/server/chat';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
} from '@/capabilities/copilot/server/copilot-run-status';
import type { Db } from '@/db/client';
// YUK-364 (bot-review C5) — 共享 Tavily 远程 MCP（web grounding），与 inline copilot
// （chat.ts runCopilotChatImpl）+ quiz_gen handler 同一份 env-gated builder。配置
// TAVILY_API_KEY 时挂 search/extract，未配置时 buildTavily() 返回 null → 与之前
// byte-identical（无 tavily server、无 tavily allowedTools）。
import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  buildTavilyMcpServer,
} from '@/server/ai/mcp/tavily';
import { runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
// YUK-364 (bot-review C4) — durable run 的 anti-runaway 护栏：只复用 inline 的
// tool-call ceiling（beforeExecute seam），不复用 per-message row cap（interceptInput
// seam，endurance 故意放宽）。endurance 故意跑得久、必然超过 inline 的 per-message
// 预算，所以 row cap 不适用；但仍需一个 tool-call 上限防 durable run 狂刷工具/proposal。
import { resolveContextBudget } from '@/server/ai/tools/budgets';
import { ContextBudgetTracker } from '@/server/ai/tools/context-throttle';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
// YUK-364 (bot-review C2) — durable run 镜像 inline 的 copilot SKILL.md 解析，让整个
// 对话方法论行为包对 durable run 生效（之前缺省 → runner skills:[] → SKILL.md 失效、
// 行为偏离正常 copilot）。resolveCopilotSkills 已是 cross-subject 共享 resolver（无
// subjectId 参数），inline + durable 直接复用同一份，零漂移。
import { resolveCopilotSkills } from '@/subjects/copilot-skills';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// dispatch 入口投递的 job 体。run_id = checkpoint_id = user_ask event id（route
// 在 enqueue 前已写 user_ask domain event，本 handler 以它做 causedByEventId 让
// tool-use mirror 串到同一因果链，与 quiz_gen triggerEventId 同款）。
export interface CopilotRunJobData {
  /** checkpoint_id = user_ask event id；既是 run handle 也是 job_events business_id。 */
  run_id: string;
  /**
   * YUK-364 — durable run 所属的 conversation 会话 id（dispatch 时 findOrCreate 得到、
   * 已写在 user_ask 上）。handler 成功路径据它写 copilot_reply domain event，让回复对
   * turns.ts 的 conversation_history 可见、user_ask 不成 phantom。
   */
  session_id: string;
  user_message: string;
  /** 'chat' | 'chip'——决定 surface / actorRef（与同步面 selectSurface 同语义）。 */
  triggered_by: 'chat' | 'chip';
  /** chip 直触可选标识，透传进 run input（同步面 chip_kind）。 */
  chip_kind?: string;
}

// 同步面 selectSurface / selectActorRef 的 worker 侧镜像（chat.ts 里是模块私有
// 函数；durable 面在 worker 进程，内联同语义避免跨包导出私有 helper）。
//
// YUK-364 (forward-compat) — chip 分支当前是死代码：dispatch gate（api/chat.ts）
// 只让 triggered_by==='chat' 入 durable 面（chip 是 UI 直触轻活，不写 user_ask）。
// 保留 chip 分支让 handler 形态与同步面对齐，待将来 chip 也入 durable 时零改动。
function selectSurface(triggeredBy: CopilotRunJobData['triggered_by']) {
  return triggeredBy === 'chip'
    ? ('copilot_user_suggested_mistake_action' as const)
    : ('copilot' as const);
}
function selectActorRef(triggeredBy: CopilotRunJobData['triggered_by']) {
  return triggeredBy === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
}

export interface RunCopilotRunParams {
  db: Db;
  data: CopilotRunJobData;
  /** test seam — 默认 runAgentTask。 */
  runAgentTaskFn?: typeof runAgentTask;
  /** test seam — 默认 buildMcpServerFromRegistry。 */
  buildMcpServerFn?: typeof buildMcpServerFromRegistry;
  // YUK-364 (bot-review C5) — test seam，默认 env-gated buildTavilyMcpServer。注入
  // 返回 null 即不挂 Tavily（与未配置 TAVILY_API_KEY 同），注入 fixture 验证挂载。
  buildTavilyMcpServerFn?: () => McpHttpServerConfig | null;
  // YUK-364 (bot-review C2) — test seam，默认 resolveCopilotSkills（读 <cwd>/src/
  // subjects/_shared/skills/copilot/SKILL.md）。注入 () => ['copilot'] 验证传入，
  // () => undefined 验证降级（ctx 省略 skills，runner skills ?? [] 不变）。
  resolveCopilotSkillsFn?: typeof resolveCopilotSkills;
}

export type RunCopilotRunResult =
  | { status: 'done'; reply: string; task_run_id: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

export async function runCopilotRun(params: RunCopilotRunParams): Promise<RunCopilotRunResult> {
  const { db, data } = params;
  const run = params.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = params.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const buildTavily = params.buildTavilyMcpServerFn ?? buildTavilyMcpServer;
  const resolveSkills = params.resolveCopilotSkillsFn ?? resolveCopilotSkills;
  const runId = data.run_id;
  const surface = selectSurface(data.triggered_by);
  const actorRef = selectActorRef(data.triggered_by);
  const taskRunId = `copilot_run_tool_${runId}`;

  // 启动前 replay 一次：F3 terminal-already-present 守卫 + 协作取消（v1：回合间
  // 早停，不做 live-steer）。run handle 是 run_id，取消请求 / 终态事件由别处或上一
  // 次投递写进同一 business_id。
  const priorEvents = await computeReplay(db, {
    businessTable: COPILOT_RUN_TABLE,
    businessId: runId,
    lastEventId: 0,
  });

  // YUK-364 (bot-review C1) — terminal-already-present 守卫（防成功后重投的重复
  // 副作用），但**只对 DONE（成功终态）+ cancelled（用户意图终态）跳过**，对普通
  // FAILED **不跳过**（救活 pg-boss retry）。
  //
  // 根因：queue 'agent' 档无显式 retryLimit（pg-boss 默认即 redeliver），且
  // EXPIRE_AGENT=2h 超时也会 redeliver。原守卫见任何 FAILED 就返回 failed/不重跑，
  // 导致 catch 写 failed + re-throw → pg-boss redeliver → 守卫见 FAILED → 直接返回
  // failed → **transient 模型/工具故障被首次尝试变成永久失败，retry/DLQ 被绕过**。
  // 修正：
  //   • DONE  → 成功终态，跳过返回现有 reply（重投不重跑、不重写，防重复副作用 +
  //             重复 STARTED/REPLY/DONE，quiz_gen:741-745 同款 hazard）。
  //   • FAILED(reason='cancelled') → 用户意图的早停终态（cancelled-before-start
  //             落在这里），按现有终态返回 cancelled，不重跑（取消是 deliberate，
  //             重跑违背用户意图）。
  //   • FAILED(其余) → transient 错误，**不跳过**：继续往下走 STARTED→SDK run，
  //             让 pg-boss redeliver 真正重跑（retry 语义恢复）。重跑会再写一轮
  //             STARTED/REPLY/DONE 事件 + 一条 copilot_reply domain event——这是
  //             retry 的预期代价（上一次 FAILED 没产生成功副作用，无重复写之忧；
  //             DONE 守卫仍兜住「成功后重投」）。
  const priorDone = priorEvents.some((e) => e.event_type === COPILOT_RUN_EVENTS.DONE);
  if (priorDone) {
    const reply = priorEvents.find((e) => e.event_type === COPILOT_RUN_EVENTS.REPLY);
    const replyMd = (reply?.payload as { reply_md?: string } | undefined)?.reply_md ?? '';
    const doneEvent = priorEvents.find((e) => e.event_type === COPILOT_RUN_EVENTS.DONE);
    const priorTaskRunId =
      (doneEvent?.payload as { task_run_id?: string } | undefined)?.task_run_id ?? taskRunId;
    return { status: 'done', reply: replyMd, task_run_id: priorTaskRunId };
  }
  // cancelled-before-start 落在 FAILED(reason='cancelled')：早停终态，不重跑。
  // 普通 FAILED（reason='error' 等）故意 NOT 在此返回——往下重跑，恢复 retry。
  const priorCancelled = priorEvents.some(
    (e) =>
      e.event_type === COPILOT_RUN_EVENTS.FAILED &&
      (e.payload as { reason?: string } | undefined)?.reason === 'cancelled',
  );
  if (priorCancelled) {
    return { status: 'cancelled' };
  }

  // F4 — 复用 copilot-run-status 的 hasCancelRequest helper（消重内联 .some()，
  // 救活 production 零调用的 dead helper）。已请求取消则早停写 failed(cancelled)。
  if (hasCancelRequest(priorEvents)) {
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'cancelled', cancelled_before_start: true },
    });
    return { status: 'cancelled' };
  }

  // started 心跳——消费者据此把 status 从 queued 推到 started。
  await writeJobEvent(db, {
    business_table: COPILOT_RUN_TABLE,
    business_id: runId,
    event_type: COPILOT_RUN_EVENTS.STARTED,
    payload: { surface, triggered_by: data.triggered_by },
  });

  // YUK-364 (bot-review C4) — anti-runaway 护栏（tool-call ceiling），故意 NOT 复用
  // inline 的 per-message row cap。ContextBudgetTracker 暴露两个互相独立的 seam：
  //   • beforeExecute → tool-call ceiling（maxToolCalls）：纯 anti-runaway，与
  //     per-message context 大小无关 —— durable 也需要它，防 run 在单个 SDK 循环里
  //     狂刷工具 / propose_*。这里挂上。
  //   • interceptInput → per-message row cap（maxNodesPlusEdges / maxEventRows）：
  //     这是「单条用户消息别把太多行塞进上下文」的 per-message 预算。endurance =
  //     「跑得久」，**故意要超过 inline 的 per-message 预算**，照搬会自相矛盾 ——
  //     所以 durable **不挂 interceptInput**（row cap 不适用于 endurance）。
  // 两个 seam 在 buildMcpServerFromRegistry 上是独立可选回调（BuildMcpServerOptions），
  // 天然可分离，故只取 beforeExecute。budget surface 复用 copilot（maxToolCalls=10）
  // 作为 v1 上限；若实测 endurance 多回合需要更高 ceiling，后续 lane 调专属 durable
  // 预算（当前先粗、最不误伤）。
  const budgetTracker = new ContextBudgetTracker(resolveContextBudget(surface));

  // ── MCP mount: 照 quiz_gen:415-435 / chat.ts:1038-1098 ────────────────────
  // copilot 全集 surface（chat surface=copilot；chip surface=user-suggested）。
  // causedByEventId = run_id（= user_ask event id）：tool-use mirror 串到同一
  // 因果链（quiz_gen triggerEventId 同款）。
  const toolNames = resolveDomainToolNames(surface);
  const mcpServer = buildMcpServer({
    ctx: {
      db,
      taskRunId,
      callerActor: { kind: 'agent', ref: actorRef },
      causedByEventId: runId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames,
    taskKind: 'CopilotTask',
    // C4 — 仅 tool-call ceiling（anti-runaway）；NO interceptInput（per-message
    // row cap 对 endurance 不适用，见上）。
    beforeExecute: (tool) => budgetTracker.beforeExecute(tool),
  });

  // YUK-364 (bot-review C5) — env-gated Tavily 远程 MCP（web grounding），照 inline
  // chat.ts:1090-1098 / quiz_gen:427-435 同款模式。TAVILY_API_KEY 未配置时
  // buildTavily() 返回 null → mcpServers / allowedTools 与之前 byte-identical
  // （无 tavily server、无 tavily tools）；配置时 durable copilot 与 inline 平价，
  // 问题需 web grounding 时不再静默失去搜索。
  const tavilyCfg = buildTavily();
  const mcpServers: Record<string, SdkMcpServer | McpHttpServerConfig> = {
    [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer,
    ...(tavilyCfg ? { [TAVILY_MCP_SERVER_NAME]: tavilyCfg } : {}),
  };
  const allowedTools = [
    ...resolveMcpAllowedTools(surface),
    ...(tavilyCfg ? TAVILY_MCP_ALLOWED_TOOLS : []),
  ];

  // YUK-364 (bot-review C2) — 解析 copilot 对话方法论 SKILL.md 白名单（与 inline
  // 同一份 resolveCopilotSkills；cross-subject 共享 resolver）。命中 → 传 ctx.skills
  // 让整个 SKILL.md 行为包对 durable run 生效；缺包（undefined）→ ctx 省略 skills →
  // runner skills ?? [] 显式禁用 → registry.ts 散文兜底（never throws，与缺包现状
  // 零差异，spread-when-present 保 byte-compat）。
  const copilotSkills = await resolveSkills();

  // durable run 不带同步面的 conversation_history / proposal_feedback / ambient
  // （那些是 inline 路径的 per-message 装配，本 lane 不抬）。v1 最小 run input：
  // 与 CopilotTask registry 契约一致的 surface/triggered_by/user_message。
  const runInput = {
    surface,
    triggered_by: data.triggered_by,
    user_message: data.user_message,
    ...(data.chip_kind ? { chip_kind: data.chip_kind } : {}),
  };

  try {
    const result = await run('CopilotTask', runInput, {
      db,
      mcpServers,
      allowedTools,
      // C2 — spread-when-present：copilotSkills===undefined 时省略 skills 字段，
      // 与 inline chat.ts 同款降级（runner ctx.skills ?? [] 不变 → 零回归）。
      ...(copilotSkills ? { skills: copilotSkills } : {}),
    });

    // YUK-364 (F1) — 写 conversation-历史可见的 copilot_reply domain event（经与
    // inline 同一份 writeCopilotReply：extractPrimaryView 剥 primary_view marker +
    // chained caused_by → user_ask，同 session_id）。turns.ts 的 conversation_history
    // 只读 copilot_user_ask + copilot_reply domain event——不写它则 durable 回复对
    // 历史不可见、user_ask 成 phantom（下一轮模型没有自己上一条 durable 答复的记忆）。
    // job_events 的 REPLY/DONE 是另一职责（SSE 进度），两者都要：domain event 给
    // 历史，job_events 给重连进度。terminal job_event 在 domain event 之后写，让
    // F3 守卫据 DONE 跳过时不会漏写 domain event（domain event 已先落）。
    const { cleanedReply } = await writeCopilotReply(db, {
      sessionId: data.session_id,
      userAskEventId: runId,
      replyText: result.text,
      actorRef,
      taskRunId: result.task_run_id,
      now: new Date(),
    });

    // 终稿 reply 事件（done 的前序：消费者可先渲染 reply 再收 done）。持久化 cleaned
    // 文本（已剥 marker），与 domain event reply_md 一致。
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.REPLY,
      payload: { reply_md: cleanedReply, task_run_id: result.task_run_id },
    });
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: { task_run_id: result.task_run_id, finish_reason: result.finishReason },
    });
    return { status: 'done', reply: cleanedReply, task_run_id: result.task_run_id };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // 失败事件先写（终态可见），再 re-throw 让 pg-boss 走 DLQ/retry 配方（agent 档）。
    // best-effort：失败事件写入本身再失败也不能吞掉原始错误。
    try {
      await writeJobEvent(db, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'error', error: message },
      });
    } catch (writeErr) {
      console.error('[copilot_run] failed-event write failed for', runId, writeErr);
    }
    throw err;
  }
}

/**
 * pg-boss handler 工厂（JobHandlerFactory 形态 `(db) => (jobs) => Promise<void>`）。
 * 注册器（register-capability-jobs.ts）固定 { pollingIntervalSeconds:2, batchSize:1 }
 * → 天然 n=1 单线程一次一 run（串行化由 batchSize:1 提供）。
 */
export function buildCopilotRunHandler(db: Db): (jobs: Job<CopilotRunJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      // session_id（YUK-364 F1）是成功路径写 copilot_reply domain event 的必要字段；
      // 缺失则该 run 无法把回复挂回 conversation 会话——跳过而非半写。
      if (!data?.run_id || !data?.session_id || !data?.user_message || !data?.triggered_by) {
        console.warn(
          '[copilot_run] job missing run_id/session_id/user_message/triggered_by',
          job.id,
        );
        continue;
      }
      const result = await runCopilotRun({ db, data });
      console.log(`[copilot_run] ${data.run_id} -> ${result.status}`);
    }
  };
}
