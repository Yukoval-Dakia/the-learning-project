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
// YUK-328 后独立 worker 在注册 handlers 前从 capability manifests 装配完整
// DomainTool registry；buildMcpServerFromRegistry 只读该启动期 inventory。

import type { Job } from 'pg-boss';

import { wrapDeltaSuppressingMarker, writeCopilotReply } from '@/capabilities/copilot/server/chat';
// YUK-575 (A1/N3) — the shared free-form run-input assembler. The durable handler
// assembles the FULL run input at pickup time (MF-B: pass excludeUserAskEventId=
// run_id to drop its own already-written user_ask; conversation_history / learner-
// state header / proposal_feedback / ambient all fresh at pickup), byte-parity with
// inline. Before YUK-575 the durable run shipped a minimal {surface,triggered_by,
// user_message} with NO session memory.
import {
  type CopilotAmbientContext,
  type CopilotRunInput,
  assembleCopilotRunInput,
} from '@/capabilities/copilot/server/copilot-run-input';
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
import { type StreamCollectResult, streamTaskCollecting } from '@/server/ai/runner';
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
  /**
   * YUK-575 (S4) — ambient context（用户当前 route + 可选 focused_entity）。它是
   * request-only、**从不 persisted**（防循环 ②：绝不写进任何 turn payload），所以
   * 必须 RIDE 这个 job payload 才能在 worker 拾取时进 run input——不像
   * conversation_history / learner-state（从事件重建），ambient 无处可重读。
   */
  ambient?: CopilotAmbientContext;
}

// YUK-575 (N5/MF-A) — durable run 的三旋钮预算，经 runner budgetOverride seam
// （maxIterations→SDK maxTurns、timeoutMs→streamTaskCollecting abort timer）+ 本
// handler 的 ContextBudgetTracker（toolCalls）per-call 覆盖 inline CopilotTask
// registry 默认（maxIterations:6 / warning:10 / hard:25 / timeout:60_000），**不 mutate
// 共享 registry**（YUK-458 revert 教训：抬 inline 默认只把 error_max_turns 变成
// inline-request abort，不解 endurance）。
//   • maxIterations:24 — 给多步 propose 编排足够回合（YUK-458 证 6 太紧）。
//   • maxToolCalls:60 — **MF-A**：durable 与 inline 同 surface='copilot'，共用
//     COPILOT_CONTEXT_BUDGET.toolCalls.hard=25；不抬它则 24 回合 × ~2-4
//     tool-call/回合会提前 soft-stop。durable 以 25 为 warning、60 为 hard，覆盖
//     24 × 2.5/回合均值，把「谁先 bind」推回 iterations 侧。
//   • timeoutMs:12min — 封病态 loop 的浪费上限；**承重约束（S6）**：必须 <
//     STUCK_RUN_THRESHOLD_MS(1h)，否则 stuck-in-running sweeper 误收敛 live run
//     （见 copilot_run.test.ts 的 static 约束断言）。远 < EXPIRE_AGENT(2h)。
// 安全帽不是目标——健康流靠模型返回 final reply 自然收，天花板只挡病态 loop。
export const DURABLE_BUDGET = {
  maxIterations: 24,
  maxToolCalls: 60,
  timeoutMs: 12 * 60_000,
} as const;

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
  /**
   * test seam — 默认 streamTaskCollecting（YUK-575 N2：durable run 边跑边流式 delta
   * 进 job_events）。real streamTaskCollecting graceful-degrades（resolve partial，
   * 不 throw）；注入一个 THROW 的 fixture 可测 MF1/MF2 的 catch 分诊路径。
   */
  streamTaskCollectingFn?: typeof streamTaskCollecting;
  /**
   * YUK-575 (A1/N3) test seam — 默认 assembleCopilotRunInput。注入 fixture 断言
   * pickup-time 装配参数（excludeUserAskEventId=run_id、ambient 透传等）而不打真 DB。
   */
  resolveCopilotRunInputFn?: typeof assembleCopilotRunInput;
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
  const streamRun = params.streamTaskCollectingFn ?? streamTaskCollecting;
  const assembleRunInput = params.resolveCopilotRunInputFn ?? assembleCopilotRunInput;
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
  // YUK-575 (Fix 2 — single-shot)：durable copilot 继承 streamTaskCollecting 的
  // graceful-degrade（run 失败经 {partial} plain-Error 回来、从不 throw AgentRunError），
  // 故 handler 对失败一律 return-without-throw 写 terminal FAILED(reason='exhausted')，
  // **不 re-throw、pg-boss 不 redeliver**（single-shot，与 inline copilot 一致；真
  // transient 自动重试延到 YUK-596）。terminal 守卫据 replay 末态跳重投：
  //   • DONE  → 成功终态，跳过返回现有 reply（重投不重跑、不重写，防重复副作用 +
  //             重复 STARTED/REPLY/DONE，quiz_gen:741-745 同款 hazard）。
  //   • FAILED(reason='cancelled') → 用户意图的早停终态（cancelled-before-start
  //             落在这里），按现有终态返回 cancelled，不重跑（取消 deliberate）。
  //   • FAILED(reason='exhausted') → 单发失败的 deliberate terminal（handleDurableFailure
  //             写它 + return，不 throw）；此守卫兜「写完 terminal 后、worker 崩溃在
  //             pg-boss 标 job complete 前」的 EXPIRE_AGENT redeliver，不重跑重烧
  //             12-min run（下方 priorExhausted）。
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

  // YUK-575 (MF2b) — terminal-no-retry 幂等守卫（镜像上面的 cancelled）。非 transient
  // 耗尽 / streamTaskCollecting graceful-degrade 的 catch/partial 分支走 write-FAILED
  // (reason='exhausted') + return（不 throw），停常规重投；但 worker 写完 FAILED、
  // pg-boss 标 job complete 前崩溃会 redeliver——此守卫据 replay 里的 FAILED
  // (reason='exhausted') 早停，不重跑重烧 12-min run。
  const priorExhausted = priorEvents.find(
    (e) =>
      e.event_type === COPILOT_RUN_EVENTS.FAILED &&
      (e.payload as { reason?: string } | undefined)?.reason === 'exhausted',
  );
  if (priorExhausted) {
    const error = (priorExhausted.payload as { error?: string } | undefined)?.error ?? 'exhausted';
    return { status: 'failed', error };
  }

  // F4 — 复用 copilot-run-status 的 hasCancelRequest helper（消重内联 .some()，
  // 救活 production 零调用的 dead helper）。已请求取消则早停写 failed(cancelled)。
  if (hasCancelRequest(priorEvents)) {
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'cancelled', cancelled_before_start: true, checkpoint_event_id: runId },
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
  //   • beforeExecute → tool-call hard ceiling：纯 anti-runaway，与
  //     per-message context 大小无关 —— durable 也需要它，防 run 在单个 SDK 循环里
  //     狂刷工具 / propose_*。这里挂上。
  //   • interceptInput → per-message row cap（maxNodesPlusEdges / maxEventRows）：
  //     这是「单条用户消息别把太多行塞进上下文」的 per-message 预算。endurance =
  //     「跑得久」，**故意要超过 inline 的 per-message 预算**，照搬会自相矛盾 ——
  //     所以 durable 的 interceptInput 只回传 tool-call warning，**不调用
  //     capInput**、不做 row accounting/cap（row cap 不适用于 endurance）。
  // 两个 seam 在 buildMcpServerFromRegistry 上是独立可选回调（BuildMcpServerOptions），
  // 天然可分离：beforeExecute 执行 hard ceiling，interceptInput 只暴露 warning notice。
  //
  // YUK-575 (MF-A) — **抬 tool-call ceiling 到 DURABLE_BUDGET.maxToolCalls(60)**。
  // 这是抬 maxIterations 的必要伴随：durable 与 inline 同 surface='copilot'，共用
  // COPILOT_CONTEXT_BUDGET.toolCalls.hard=25；durable 需要更高事故顶，避免复杂
  // propose 编排在 maxIterations:24 之前被 inline ceiling 截断（MF-A）。
  // YUK-290：base Copilot hard=25 作为 durable warning；60 仍是事故硬顶。
  // 其余 context 维度保留 base 配置但不经 capInput，故不参与 endurance row cap。
  const baseContextBudget = resolveContextBudget(surface);
  const budgetTracker = new ContextBudgetTracker({
    ...baseContextBudget,
    toolCalls: {
      warning: baseContextBudget.toolCalls.hard,
      hard: DURABLE_BUDGET.maxToolCalls,
    },
  });

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
    // C4 — tool-call hard ceiling（anti-runaway）。interceptInput 仅回传
    // warning 状态，不执行 capInput，故仍无 per-message row cap。
    beforeExecute: (tool) => budgetTracker.beforeExecute(tool),
    interceptInput: (_tool, args) => ({
      args,
      truncationNote: budgetTracker.currentNotice(),
      softStop: null,
    }),
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

  // YUK-575 (A1/N3/MF-B) — 组装 FULL run input（与 inline byte-parity）。**pickup 时**
  // 重读 conversation_history / learner-state header(YUK-574) / proposal_feedback（保
  // 新鲜，不在 dispatch 侧冻结），传 excludeUserAskEventId=runId 排除 dispatch 已写的
  // 当前 ask（durable 时序 = dispatch-写-then-pickup，不像 inline read-before-write）。
  // ambient RIDE 自 job payload（S4：request-only、从不 persisted，无处可重读）。
  const runInput: CopilotRunInput = await assembleRunInput(db, {
    sessionId: data.session_id,
    userMessage: data.user_message,
    triggeredBy: data.triggered_by,
    ...(data.chip_kind ? { chipKind: data.chip_kind } : {}),
    ...(data.ambient ? { ambient: data.ambient } : {}),
    now: new Date(),
    excludeUserAskEventId: runId,
  });

  // YUK-575 (N2/S3) — 流式 delta → job_events，FIFO promise-chain（onDelta 同步、
  // writeJobEvent 异步；fire-and-forget 会乱序 id）。terminal REPLY/DONE 前 await 排空
  // → 每条 delta id 严格早于 REPLY/DONE。primary_view marker 从 live delta 剥掉（与
  // inline 同一份 wrapDeltaSuppressingMarker；终稿 REPLY 携 cleaned 文本）。
  let deltaChain: Promise<void> = Promise.resolve();
  const onDelta = wrapDeltaSuppressingMarker((text: string) => {
    deltaChain = deltaChain.then(async () => {
      // MINOR(3) fix — per-write catch INSIDE the .then so one failed delta write
      // does not poison the chain (a rejected link would skip every subsequent
      // delta + reject the drain). Each delta is independent best-effort.
      try {
        await writeJobEvent(db, {
          business_table: COPILOT_RUN_TABLE,
          business_id: runId,
          event_type: COPILOT_RUN_EVENTS.DELTA,
          payload: { text },
        });
      } catch (err) {
        console.error('[copilot_run] delta write failed for', runId, err);
      }
    });
  });

  try {
    const result: StreamCollectResult = await streamRun(
      'CopilotTask',
      runInput,
      {
        db,
        mcpServers,
        allowedTools,
        // C2 — spread-when-present：copilotSkills===undefined 时省略 skills 字段，
        // 与 inline chat.ts 同款降级（runner ctx.skills ?? [] 不变 → 零回归）。
        ...(copilotSkills ? { skills: copilotSkills } : {}),
        // YUK-575 (N5/MF-A) — durable ceiling：maxIterations→SDK maxTurns、
        // timeoutMs→streamTaskCollecting abort timer（maxToolCalls 在上方 tracker）。
        budgetOverride: {
          maxIterations: DURABLE_BUDGET.maxIterations,
          timeoutMs: DURABLE_BUDGET.timeoutMs,
        },
      },
      onDelta,
    );
    // S3 — 排空 delta 链：所有 delta id 落定后再写 terminal。
    await drainDeltaChain(deltaChain, runId);

    // YUK-575 — streamTaskCollecting graceful-degrade：run 出错时它 resolve
    // { partial:true, error }（plain Error 内含）而非 throw。partial = run 跑了但失败
    // （可能有半程文本）→ terminal-no-retry（handleDurableFailure 写 FAILED(exhausted)
    // + 半程文本/错误 reply + return，不 pg-boss 重烧；重投=从头丢 partial）。
    if (result.partial) {
      return await handleDurableFailure(db, {
        err: new Error(result.error ?? 'run failed'),
        runId,
        sessionId: data.session_id,
        actorRef,
        partialText: result.text,
      });
    }

    // YUK-364 (F1) — 成功：写 conversation-历史可见的 copilot_reply domain event（经与
    // inline 同一份 writeCopilotReply：extractPrimaryView 剥 primary_view marker +
    // chained caused_by → user_ask，同 session_id）。turns.ts 的 conversation_history
    // 只读 copilot_user_ask + copilot_reply domain event——不写它则 durable 回复对历史
    // 不可见、user_ask 成 phantom。terminal job_event 在 domain event 之后写。
    const { cleanedReply } = await writeCopilotReply(db, {
      sessionId: data.session_id,
      userAskEventId: runId,
      replyText: result.text,
      actorRef,
      taskRunId: result.task_run_id,
      now: new Date(),
    });
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.REPLY,
      payload: {
        reply_md: cleanedReply,
        task_run_id: result.task_run_id,
        checkpoint_event_id: runId,
      },
    });
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: {
        task_run_id: result.task_run_id,
        finish_reason: result.finishReason,
        checkpoint_event_id: runId,
      },
    });
    return { status: 'done', reply: cleanedReply, task_run_id: result.task_run_id };
  } catch (err) {
    // streamTaskCollecting graceful-degrades（resolve partial，见上），故这里只捕获
    // 它之外的 throw（装配 / MCP mount / 事件写），或注入 fixture 的 throw（测 MF1/MF2）。
    await drainDeltaChain(deltaChain, runId);
    return await handleDurableFailure(db, {
      err,
      runId,
      sessionId: data.session_id,
      actorRef,
    });
  }
}

/** S3 — 排空 delta 写链（best-effort：一条 delta 写失败不吞掉 run，也不阻 terminal）。 */
async function drainDeltaChain(chain: Promise<void>, runId: string): Promise<void> {
  try {
    await chain;
  } catch (err) {
    console.error('[copilot_run] delta chain write failed for', runId, err);
  }
}

/**
 * YUK-575 (Fix 2 — single-shot) — durable 失败处理。**无 transient/redeliver 分诊**：
 * durable copilot 继承 streamTaskCollecting 的 graceful-degrade——run 失败经 `{partial}`
 * （plain Error）回来、从不 throw AgentRunError，故每个 durable 失败都是 deliberate
 * TERMINAL（single-shot），与 inline copilot 今天完全一致（inline 共享
 * streamTaskCollecting、从来没有 transient 自动重试，一直 graceful-degrade 成 partial
 * reply）。**真 transient 自动重试**（把 AgentFailureSubtype 穿过 StreamCollectResult
 * 让 pg-boss redeliver）**延到 YUK-596**——那里 durable 成默认（每回合都 durable），
 * single-shot 失败才真正 load-bearing、更重的 runner 契约变更才有正当性。
 *
 * 顺序：terminal FAILED(reason='exhausted') 先写（dock terminal 标记 + 上方
 * priorExhausted 守卫据它跳「写完 terminal 后 pg-boss commit 前崩溃」的重投），再
 * best-effort 写 phantom-preventing copilot_reply（镜像 chat.ts F2——partial 有文本则
 * 持久化半程文本，否则错误提示，让 user_ask 不成 conversation_history 的 phantom）。
 * 两写都 best-effort、不互相阻断、不 throw（single-shot：pg-boss 不 redeliver）。
 */
async function handleDurableFailure(
  db: Db,
  args: {
    err: unknown;
    runId: string;
    sessionId: string;
    actorRef: string;
    /** streamTaskCollecting graceful-degrade 的半程文本（若有），作 phantom-reply 正文。 */
    partialText?: string;
  },
): Promise<RunCopilotRunResult> {
  const { err, runId, sessionId, actorRef, partialText } = args;
  const message = String((err as Error)?.message ?? err);

  try {
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'exhausted', error: message, checkpoint_event_id: runId },
    });
  } catch (writeErr) {
    console.error('[copilot_run] terminal-failed write failed for', runId, writeErr);
  }
  const replyText =
    partialText && partialText.length > 0
      ? partialText
      : '这次后台运行没能在预算内收敛完成。可以换个更聚焦的问法再试。';
  try {
    await writeCopilotReply(db, {
      sessionId,
      userAskEventId: runId,
      replyText,
      actorRef,
      taskRunId: `copilot_run_exhausted_${runId}`,
      now: new Date(),
    });
  } catch (replyErr) {
    console.error('[copilot_run] exhausted copilot_reply write failed for', runId, replyErr);
  }
  return { status: 'failed', error: message };
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
