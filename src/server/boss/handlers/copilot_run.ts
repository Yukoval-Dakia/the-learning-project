// YUK-364 (ADR-0041 endurance W1 L2) — durable copilot run handler。
//
// 把 copilot 从同步面（src/capabilities/copilot/server/chat.ts 的 inline
// streamTaskCollecting）桥到异步 durable pg-boss 面：route dispatch（durable
// 标记）→ boss.send('copilot_run', {...}) → 本 handler 在 worker 进程跑一个
// CopilotTask run，边跑边写安全 STEP 进度；模型正文先缓冲并经 YUK-832 最终证据
// 审阅，outcome marker 提交后才把审阅终稿写进 job_events。SSE 消费者经
// computeReplay 订阅。
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

import { isDurableWorkerTouchEvent } from '@/capabilities/copilot/durable-pickup';
import { writeCopilotReply } from '@/capabilities/copilot/server/chat';
import {
  COPILOT_CANCEL_DRAIN_GRACE_MS,
  type CopilotRunCancellationControl,
  type PersistCopilotRunCancellationArgs,
  createCopilotRunCancellationControl,
  persistCopilotRunCancellationMarker,
} from '@/capabilities/copilot/server/copilot-run-cancellation';
import { acquireCopilotExecutionSettlementLock } from '@/capabilities/copilot/server/copilot-run-coordination';
// YUK-575 (A1/N3) — the shared free-form run-input assembler. The durable handler
// assembles the FULL run input at pickup time (YUK-596: pass run_id as a causal
// history anchor in the job's fixed session; conversation_history / learner-state
// header / proposal_feedback / ambient all fresh at pickup), byte-parity with
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
  isCopilotRunTerminalEvent,
} from '@/capabilities/copilot/server/copilot-run-status';
import { withCopilotDurableDispatchLock } from '@/capabilities/copilot/server/durable-dispatch';
import {
  COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS,
  reviewCopilotEvidenceReply,
} from '@/capabilities/copilot/server/evidence-review';
import { selectAsksWithMaterializingToolCall } from '@/capabilities/copilot/server/materializing-tools';
import {
  buildCopilotSubagents,
  createCopilotSubtaskProjector,
  isCopilotSubagentEnabled,
} from '@/capabilities/copilot/server/subagents';
import type { Db, Tx } from '@/db/client';
import { event, job_events } from '@/db/schema';
// YUK-364 (bot-review C5) — 共享 Tavily 远程 MCP（web grounding），与 inline copilot
// （chat.ts runCopilotChatImpl）+ quiz_gen handler 同一份 env-gated builder。配置
// TAVILY_API_KEY 时挂 search/extract，未配置时 buildTavily() 返回 null → 与之前
// byte-identical（无 tavily server、无 tavily allowedTools）。
import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  buildTavilyMcpServer,
} from '@/server/ai/mcp/tavily';
import {
  type StreamCollectResult,
  type TaskEventMessage,
  streamTaskCollecting,
} from '@/server/ai/runner';
import {
  SPAWN_TOOL_NAME,
  type SpawnBudgetObservation,
  createSpawnContract,
} from '@/server/ai/spawn-contract';
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
import {
  type SdkMcpServer,
  type ToolExecutionResultObservation,
  buildMcpServerFromRegistry,
} from '@/server/ai/tools/mcp-bridge';
import {
  type BossJobObservation,
  type BossJobObserver,
  observeBossJob,
} from '@/server/boss/job-observation';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
// YUK-364 (bot-review C2) — durable run 镜像 inline 的 copilot SKILL.md 解析，让整个
// 对话方法论行为包对 durable run 生效（之前缺省 → runner skills:[] → SKILL.md 失效、
// 行为偏离正常 copilot）。resolveCopilotSkills 已是 cross-subject 共享 resolver（无
// subjectId 参数），inline + durable 直接复用同一份，零漂移。
import { resolveCopilotSkills } from '@/subjects/copilot-skills';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

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
   * test seam — 默认 streamTaskCollecting。YUK-832 起 candidate delta 只在内存收集，
   * 证据审阅 + outcome marker 提交后才发布安全 delta。real streamTaskCollecting
   * graceful-degrades（resolve partial，不 throw）；注入 THROW fixture 可测 catch 路径。
   */
  streamTaskCollectingFn?: typeof streamTaskCollecting;
  /**
   * YUK-575 (A1/N3) test seam — 默认 assembleCopilotRunInput。注入 fixture 断言
   * pickup-time 装配参数（historyAnchorEventId=run_id、ambient 透传等）而不打真 DB。
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
  /** Test/ops seam for the default-on COPILOT_SUBAGENT_ENABLED kill switch. */
  copilotSubagentEnabled?: boolean;
  /** Report-only observation seam; native tool-call/cost logs remain authoritative. */
  onSpawnBudgetObservation?: (observation: SpawnBudgetObservation) => void;
  /** Test seam for the transactional REPLY+DONE projection and redelivery repair. */
  writeSuccessfulTerminalProjectionFn?: WriteSuccessfulTerminalProjectionFn;
  /** Test seam for the FAILED projection and redelivery repair. */
  writeFailedTerminalProjectionFn?: WriteFailedTerminalProjectionFn;
  /** Test seam for the domain outcome marker written after paid execution. */
  writeCopilotReplyFn?: typeof writeCopilotReply;
  /** YUK-832 — no-tool final evidence validator; injectable for product-level tests. */
  reviewEvidenceReplyFn?: typeof reviewCopilotEvidenceReply;
  /** Test seam for the load-bearing atomic paid-execution claim. */
  claimExecutionFenceFn?: ClaimCopilotExecutionFenceFn;
  /** Test seam for the cross-process cancellation observer/controller. */
  createCancellationControlFn?: typeof createCopilotRunCancellationControl;
}

export type RunCopilotRunResult =
  | { status: 'done'; reply: string; task_run_id: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

interface SuccessfulTerminalProjection {
  runId: string;
  replyMd: string;
  taskRunId: string;
  finishReason: string;
}

export interface TerminalProjectionEvent {
  id?: number;
  event_type: string;
  payload?: Record<string, unknown>;
  occurred_at?: Date;
}

interface FailedTerminalProjection {
  runId: string;
  error: string;
  reason: 'cancelled' | 'exhausted' | 'ambiguous_execution' | 'pre_execution_lost';
  /** Explicit fail-closed override when a materializing tool began before Stop. */
  checkpointSafe?: boolean;
  /** User-facing terminal copy for the live job-events consumer. */
  replyMd?: string;
}

type WriteJobEventFn = (tx: Db | Tx, input: Parameters<typeof writeJobEvent>[1]) => Promise<number>;

type ClaimCopilotExecutionFenceResult =
  | { outcome: 'claimed' }
  | { outcome: 'existing' }
  | { outcome: 'cancelled' }
  | { outcome: 'terminal'; events: TerminalProjectionEvent[] };

type ClaimCopilotExecutionFenceFn = (
  db: Db,
  runId: string,
) => Promise<ClaimCopilotExecutionFenceResult>;

type MarkCopilotRunStartedResult =
  | { outcome: 'started' }
  | { outcome: 'cancelled' }
  | { outcome: 'terminal'; events: TerminalProjectionEvent[] };

/** Prevent a late worker pickup from appending STARTED behind a Stop terminal. */
export async function markCopilotRunStarted(
  db: Db,
  runId: string,
  payload: Record<string, unknown>,
  options: { writeJobEventFn?: WriteJobEventFn } = {},
): Promise<MarkCopilotRunStartedResult> {
  const write = options.writeJobEventFn ?? writeJobEvent;
  return withCopilotDurableDispatchLock(db, runId, async (tx) => {
    const events = await tx
      .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));
    if (hasCopilotSettlementTerminal(events)) return { outcome: 'terminal', events };
    if (hasCancelRequest(events)) {
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'cancelled', cancelled_before_start: true, checkpoint_event_id: runId },
      });
      return { outcome: 'cancelled' };
    }
    if (!events.some((event) => event.event_type === COPILOT_RUN_EVENTS.STARTED)) {
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.STARTED,
        payload,
      });
    }
    return { outcome: 'started' };
  });
}

/**
 * Atomically claim the one paid/tool execution allowed for a run. The dispatch
 * advisory lock is shared with API enqueue-failure compensation, so a worker
 * cannot pass a stale replay, let enqueue_failed commit, and then start paid
 * work. It also serializes overlapping deliveries before appending the fence.
 */
export async function claimCopilotExecutionFence(
  db: Db,
  runId: string,
  options: { writeJobEventFn?: WriteJobEventFn } = {},
): Promise<ClaimCopilotExecutionFenceResult> {
  const write = options.writeJobEventFn ?? writeJobEvent;
  return withCopilotDurableDispatchLock(db, runId, async (tx) => {
    const events = await tx
      .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));
    if (hasCopilotSettlementTerminal(events)) return { outcome: 'terminal', events };
    if (events.some((event) => event.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED)) {
      return { outcome: 'existing' };
    }
    if (hasCancelRequest(events)) {
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'cancelled', cancelled_before_start: true, checkpoint_event_id: runId },
      });
      return { outcome: 'cancelled' };
    }
    await write(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      payload: { execution_fence: 'at_most_once' },
    });
    return { outcome: 'claimed' };
  });
}

export type WriteSuccessfulTerminalProjectionFn = (
  db: Db | Tx,
  projection: SuccessfulTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
) => Promise<void>;

export type WriteFailedTerminalProjectionFn = (
  db: Db | Tx,
  projection: FailedTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
) => Promise<void>;

class DurableTerminalProjectionError extends Error {
  constructor(runId: string, outcome: 'success' | 'failure', cause: unknown) {
    super(`durable ${outcome} terminal projection failed for ${runId}`, { cause });
    this.name = 'DurableTerminalProjectionError';
  }
}

function isRootDb(database: Db | Tx): database is Db {
  return '$client' in database;
}

async function withinExistingOrNewTransaction<T>(
  database: Db | Tx,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return isRootDb(database) ? database.transaction(run) : run(database);
}

async function durableCheckpointPayload(
  db: Db | Tx,
  runId: string,
): Promise<Record<string, string>> {
  let turnMaterialized: boolean;
  try {
    turnMaterialized = (await selectAsksWithMaterializingToolCall(db, [runId])).has(runId);
  } catch (probeErr) {
    console.error('[copilot_run] materializing-tool probe failed; suppressing revert anchor', {
      runId,
      error: probeErr,
    });
    turnMaterialized = true;
  }
  return turnMaterialized ? {} : { checkpoint_event_id: runId };
}

/**
 * Project a persisted successful domain reply into the public job-event stream.
 * REPLY + DONE are one transaction: clients/backlog can never observe a
 * permanently half-written successful terminal. Existing rows are honoured so
 * a pg-boss redelivery repairs only the missing suffix.
 */
export async function writeSuccessfulTerminalProjection(
  db: Db | Tx,
  projection: SuccessfulTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
  options: { writeJobEventFn?: WriteJobEventFn } = {},
): Promise<void> {
  const write = options.writeJobEventFn ?? writeJobEvent;
  const existingTypes = new Set(priorEvents.map((item) => item.event_type));
  if (existingTypes.has(COPILOT_RUN_EVENTS.DONE)) return;

  const checkpointPayload = await durableCheckpointPayload(db, projection.runId);

  await withinExistingOrNewTransaction(db, async (tx) => {
    if (!existingTypes.has(COPILOT_RUN_EVENTS.REPLY)) {
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: projection.runId,
        event_type: COPILOT_RUN_EVENTS.REPLY,
        payload: {
          reply_md: projection.replyMd,
          task_run_id: projection.taskRunId,
          ...checkpointPayload,
        },
      });
    }
    await write(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: projection.runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: {
        task_run_id: projection.taskRunId,
        finish_reason: projection.finishReason,
        ...checkpointPayload,
      },
    });
  });
}

/** Project a persisted failed domain reply into one load-bearing FAILED frame. */
export async function writeFailedTerminalProjection(
  db: Db | Tx,
  projection: FailedTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
  options: { writeJobEventFn?: WriteJobEventFn } = {},
): Promise<void> {
  // FAILED(reason=error) is a retryable legacy frame, not the outcome of this
  // paid attempt. It must not suppress a new exhausted/ambiguous projection.
  if (
    priorEvents.some(
      (event) => event.event_type === COPILOT_RUN_EVENTS.FAILED && isCopilotRunTerminalEvent(event),
    )
  ) {
    return;
  }
  const write = options.writeJobEventFn ?? writeJobEvent;
  // An execution fence proves the model/tools may have run, not which external
  // effects committed. Missing mirrors during a DB outage cannot make that
  // work safely revertible, so ambiguous recovery never advertises an anchor.
  const checkpointPayload =
    projection.reason === 'ambiguous_execution' || projection.checkpointSafe === false
      ? {}
      : await durableCheckpointPayload(db, projection.runId);
  await withinExistingOrNewTransaction(db, async (tx) => {
    await write(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: projection.runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: projection.reason,
        error: projection.error,
        ...(projection.replyMd ? { reply_md: projection.replyMd } : {}),
        ...checkpointPayload,
      },
    });
  });
}

type PersistedDurableReply =
  | (({ outcome: 'success' } & Omit<SuccessfulTerminalProjection, 'runId'>) & {
      emitReviewedDelta?: boolean;
    })
  | {
      outcome: 'failure';
      replyMd: string;
      taskRunId: string;
      reason: 'cancelled' | 'exhausted' | 'ambiguous_execution' | 'pre_execution_lost';
      error: string;
      checkpointSafe?: boolean;
      emitReviewedDelta?: boolean;
    };

async function findPersistedDurableReply(
  db: Db | Tx,
  runId: string,
): Promise<PersistedDurableReply | null> {
  const rows = await db
    .select({ outcome: event.outcome, payload: event.payload, taskRunId: event.task_run_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:copilot_reply'),
        eq(event.caused_by_event_id, runId),
        inArray(event.outcome, ['success', 'failure']),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload as Record<string, unknown>;
  const replyMd = payload.reply_md;
  const taskRunId = row.taskRunId ?? payload.task_run_id;
  if (typeof replyMd !== 'string' || typeof taskRunId !== 'string') return null;
  if (row.outcome === 'failure') {
    const failure = payload.durable_failure;
    const failureRecord =
      failure && typeof failure === 'object' && !Array.isArray(failure)
        ? (failure as Record<string, unknown>)
        : {};
    const reason =
      failureRecord.reason === 'cancelled'
        ? 'cancelled'
        : failureRecord.reason === 'ambiguous_execution'
          ? 'ambiguous_execution'
          : failureRecord.reason === 'pre_execution_lost'
            ? 'pre_execution_lost'
            : 'exhausted';
    return {
      outcome: 'failure',
      replyMd,
      taskRunId,
      reason,
      error: typeof failureRecord.error === 'string' ? failureRecord.error : replyMd,
      ...(failureRecord.checkpoint_safe === false ? { checkpointSafe: false } : {}),
      ...(payload.durable_emit_reviewed_delta === true ? { emitReviewedDelta: true } : {}),
    };
  }
  if (row.outcome !== 'success') return null;
  return {
    outcome: 'success',
    replyMd,
    taskRunId,
    finishReason:
      typeof payload.durable_finish_reason === 'string'
        ? payload.durable_finish_reason
        : 'recovered',
    ...(payload.durable_emit_reviewed_delta === true ? { emitReviewedDelta: true } : {}),
  };
}

function observeCopilotSpawnBudget(observation: SpawnBudgetObservation): void {
  console.info('[copilot_run] spawn_budget_observation', {
    event: 'copilot_spawn_budget_observation',
    mode: observation.mode,
    tool_use_id: observation.toolUseId,
    ordinal: observation.ordinal,
    decision: observation.decision,
  });
}

const CLAIMED_EXECUTION_POLL_MS = 250;
export const CLAIMED_EXECUTION_SETTLE_GRACE_MS = 30_000;
export const DURABLE_OWNER_SETTLEMENT_BUDGET_MS =
  DURABLE_BUDGET.timeoutMs + COPILOT_EVIDENCE_REVIEW_TIMEOUT_MS + CLAIMED_EXECUTION_SETTLE_GRACE_MS;

export function hasCopilotSettlementTerminal(events: TerminalProjectionEvent[]): boolean {
  return events.some(isCopilotRunTerminalEvent);
}

type CopilotExecutionSettlement<T> =
  | { outcome: 'settled'; value: T }
  | { outcome: 'already_terminal'; events: TerminalProjectionEvent[] };

/**
 * Serialize every paid-owner outcome and ambiguous recovery for one run. The
 * expensive model/tool loop deliberately runs outside this lock; only its
 * durable settlement is protected. Recovery may win after the owner deadline,
 * but a late owner then observes that terminal under this same lock and cannot
 * append a contradictory reply/DONE.
 */
async function withCopilotExecutionSettlementLock<T>(
  db: Db,
  runId: string,
  settle: (tx: Tx, priorEvents: TerminalProjectionEvent[]) => Promise<T>,
): Promise<CopilotExecutionSettlement<T>> {
  return db.transaction(async (tx) => {
    await acquireCopilotExecutionSettlementLock(tx, runId);
    const priorEvents = await tx
      .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));
    // A legacy FAILED(reason=error) is intentionally retryable. It must not
    // discard the successful outcome of that paid retry at settlement time.
    if (hasCopilotSettlementTerminal(priorEvents)) {
      return { outcome: 'already_terminal' as const, events: priorEvents };
    }
    return { outcome: 'settled' as const, value: await settle(tx, priorEvents) };
  });
}

function terminalRunResult(
  events: TerminalProjectionEvent[],
  fallbackTaskRunId: string,
): RunCopilotRunResult {
  const newestFirst = [...events].reverse();
  const done = newestFirst.find((event) => event.event_type === COPILOT_RUN_EVENTS.DONE);
  if (done) {
    const reply = newestFirst.find((event) => event.event_type === COPILOT_RUN_EVENTS.REPLY);
    return {
      status: 'done',
      reply: typeof reply?.payload?.reply_md === 'string' ? reply.payload.reply_md : '',
      task_run_id:
        typeof done.payload?.task_run_id === 'string'
          ? done.payload.task_run_id
          : fallbackTaskRunId,
    };
  }
  const failed = newestFirst.find(
    (event) => event.event_type === COPILOT_RUN_EVENTS.FAILED && isCopilotRunTerminalEvent(event),
  );
  const reason = typeof failed?.payload?.reason === 'string' ? failed.payload.reason : 'failed';
  if (reason === 'cancelled') return { status: 'cancelled' };
  return {
    status: 'failed',
    error: typeof failed?.payload?.error === 'string' ? failed.payload.error : reason,
  };
}

type CopilotOutcomeMarkerClaim =
  | { outcome: 'marker'; marker: PersistedDurableReply }
  | { outcome: 'already_terminal'; events: TerminalProjectionEvent[] };

/**
 * Persist the authoritative domain outcome while holding the settlement lock,
 * but commit it before projecting the public suffix. This preserves the known
 * paid result if a later REPLY/DONE/FAILED write fails; redelivery can repair
 * that suffix without re-running model/tools.
 */
async function ensureCopilotOutcomeMarker(
  db: Db,
  runId: string,
  create: (tx: Tx) => Promise<PersistedDurableReply>,
  options: { createCancelled?: (tx: Tx) => Promise<PersistedDurableReply> } = {},
): Promise<CopilotOutcomeMarkerClaim> {
  const settlement = await withCopilotExecutionSettlementLock(
    db,
    runId,
    async (tx, lockedEvents) => {
      const persisted = await findPersistedDurableReply(tx, runId);
      if (persisted) return persisted;
      if (options.createCancelled && hasCancelRequest(lockedEvents)) {
        return options.createCancelled(tx);
      }
      return create(tx);
    },
  );
  return settlement.outcome === 'settled'
    ? { outcome: 'marker', marker: settlement.value }
    : settlement;
}

/** Re-acquire the same lock and project exactly the marker that actually won. */
async function projectCopilotOutcomeMarker(
  db: Db,
  runId: string,
  fallbackTaskRunId: string,
  projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn,
  projectFailedTerminal: WriteFailedTerminalProjectionFn,
): Promise<RunCopilotRunResult> {
  const settlement = await withCopilotExecutionSettlementLock(
    db,
    runId,
    async (tx, lockedEvents) => {
      const marker = await findPersistedDurableReply(tx, runId);
      if (!marker) throw new Error(`durable outcome marker missing for ${runId}`);
      // YUK-832: the domain marker records whether the primary stream produced
      // user-facing text. Publish one reviewed full-text DELTA inside this same
      // settlement transaction, immediately before the terminal projection.
      // An owner crash after marker commit is therefore repaired identically by
      // redelivery/reconcile, and no interleaving can produce REPLY,DONE,DELTA.
      if (marker.emitReviewedDelta && marker.replyMd.length > 0) {
        await writeJobEvent(tx, {
          business_table: COPILOT_RUN_TABLE,
          business_id: runId,
          event_type: COPILOT_RUN_EVENTS.DELTA,
          payload: { text: marker.replyMd },
        });
      }
      if (marker.outcome === 'success') {
        await projectSuccessfulTerminal(tx, { runId, ...marker }, lockedEvents);
        return {
          status: 'done' as const,
          reply: marker.replyMd,
          task_run_id: marker.taskRunId,
        };
      }
      await projectFailedTerminal(
        tx,
        {
          runId,
          reason: marker.reason,
          error: marker.error,
          replyMd: marker.replyMd,
          checkpointSafe: marker.checkpointSafe,
        },
        lockedEvents,
      );
      return marker.reason === 'cancelled'
        ? ({ status: 'cancelled' } as const)
        : ({ status: 'failed' as const, error: marker.error } as const);
    },
  );
  return settlement.outcome === 'settled'
    ? settlement.value
    : terminalRunResult(settlement.events, fallbackTaskRunId);
}

/**
 * An overlapping physical delivery must neither execute nor declare the live
 * owner ambiguous. Wait within the 2h pg-boss lease for the primary + final
 * review + settlement owner budget, then re-enter through normal replay guards. If the owner crashed,
 * the expired fence becomes an honest ambiguous terminal; if it committed an
 * outcome/terminal, replay repairs or returns it without paid work.
 */
async function awaitClaimedCopilotExecution(
  params: RunCopilotRunParams,
  deadlineMs: number,
): Promise<RunCopilotRunResult> {
  while (Date.now() < deadlineMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(CLAIMED_EXECUTION_POLL_MS, deadlineMs - Date.now())),
    );
    try {
      const events = await computeReplay(params.db, {
        businessTable: COPILOT_RUN_TABLE,
        businessId: params.data.run_id,
        lastEventId: 0,
      });
      // FAILED(reason=error) is retryable. Treating it as settled would recurse
      // straight back into this same live fence with no state change.
      if (hasCopilotSettlementTerminal(events)) return runCopilotRun(params);
    } catch (error) {
      // A transient observation failure is not evidence that the owner died.
      // Keep waiting instead of creating a premature ambiguous terminal.
      console.error('[copilot_run] execution-owner observation failed', {
        runId: params.data.run_id,
        error,
      });
    }
  }
  return runCopilotRun(params);
}

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
  const projectSuccessfulTerminal =
    params.writeSuccessfulTerminalProjectionFn ?? writeSuccessfulTerminalProjection;
  const projectFailedTerminal =
    params.writeFailedTerminalProjectionFn ?? writeFailedTerminalProjection;
  const persistReply = params.writeCopilotReplyFn ?? writeCopilotReply;
  const reviewEvidenceReply = params.reviewEvidenceReplyFn ?? reviewCopilotEvidenceReply;
  const claimExecutionFence = params.claimExecutionFenceFn ?? claimCopilotExecutionFence;
  const createCancellationControl =
    params.createCancellationControlFn ?? createCopilotRunCancellationControl;

  // 启动前 replay 一次：F3 terminal-already-present 守卫 + pre-fence 协作取消。
  // 运行中 Stop 由下方 cancellation control 的 poll / SDK hook / DomainTool gate
  // 接管；run handle 是 run_id，所有请求/终态仍写进同一 business_id。
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
  // graceful-degrade（run 失败经 {partial} plain-Error 回来、从不 throw AgentRunError）。
  // 业务失败仍写 terminal FAILED(reason='exhausted') 后 return-without-throw；只有终态
  // projection 失败会抛给 pg-boss，重投据 durable reply marker 修复而不重跑 paid work。
  // 真 transient runner 自动重试延到 YUK-596。terminal 守卫据 replay 末态跳重投：
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

  // The API writes enqueue_failed only after a deterministic pg-boss readback
  // proved the stable job absent, while still holding the dispatch lock. A late
  // in-flight database commit is nevertheless possible at the transport edge;
  // if such a job is eventually delivered, the public run is already terminal
  // and paid/tool execution must not start behind that FAILED result.
  const priorTerminalFailure = priorEvents.some(
    (event) => event.event_type === COPILOT_RUN_EVENTS.FAILED && isCopilotRunTerminalEvent(event),
  );
  if (priorTerminalFailure) {
    return terminalRunResult(priorEvents, taskRunId);
  }

  // The paid model/tools may already have completed and persisted their domain
  // reply while the trailing terminal projection failed. That outcome marker
  // is authoritative: repair the success/failure projection and return without
  // STARTED, model/tool execution, or a second conversation reply.
  const persistedReply = await findPersistedDurableReply(db, runId);
  if (persistedReply?.outcome === 'success') {
    try {
      return await projectCopilotOutcomeMarker(
        db,
        runId,
        taskRunId,
        projectSuccessfulTerminal,
        projectFailedTerminal,
      );
    } catch (projectionErr) {
      throw new DurableTerminalProjectionError(runId, 'success', projectionErr);
    }
  }
  if (persistedReply?.outcome === 'failure') {
    try {
      return await projectCopilotOutcomeMarker(
        db,
        runId,
        taskRunId,
        projectSuccessfulTerminal,
        projectFailedTerminal,
      );
    } catch (projectionErr) {
      throw new DurableTerminalProjectionError(runId, 'failure', projectionErr);
    }
  }
  // EXECUTION_STARTED is the load-bearing at-most-once fence committed
  // immediately before streamRun below. A redelivery that sees the fence but no
  // durable outcome cannot know whether paid model/tool work committed before a
  // DB/process failure. Re-running would duplicate cost and potentially external
  // side effects, so recover to an honest ambiguous terminal instead.
  const priorExecutionFence = priorEvents.find(
    (event) => event.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED,
  );
  if (priorExecutionFence) {
    const ownerDeadlineMs =
      priorExecutionFence.occurred_at.getTime() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS;
    if (Date.now() < ownerDeadlineMs) {
      return awaitClaimedCopilotExecution(params, ownerDeadlineMs);
    }
    return handleAmbiguousExecution(db, {
      runId,
      sessionId: data.session_id,
      actorRef,
      projectSuccessfulTerminal,
      projectFailedTerminal,
      writeCopilotReplyFn: persistReply,
    });
  }

  // Worker-touch heartbeat stays early so pickup-stall detection does not
  // mislabel deterministic DB/input assembly as a dead worker. This is not the
  // paid execution fence; EXECUTION_STARTED below owns that stronger contract.
  // The dispatch lock prevents this advisory heartbeat from landing after a
  // concurrent pre-fence Stop has already written its terminal suffix.
  const started = await markCopilotRunStarted(db, runId, {
    surface,
    triggered_by: data.triggered_by,
  });
  if (started.outcome === 'terminal') return terminalRunResult(started.events, taskRunId);
  if (started.outcome === 'cancelled') return { status: 'cancelled' };

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
  const cancellationControl: CopilotRunCancellationControl = createCancellationControl({
    db,
    runId,
  });
  const toolTrace: ToolExecutionResultObservation[] = [];

  // ── MCP mount: 照 quiz_gen:415-435 / chat.ts:1038-1098 ────────────────────
  // copilot 全集 surface（chat surface=copilot；chip surface=user-suggested）。
  // causedByEventId = run_id（= user_ask event id）：tool-use mirror 串到同一
  // 因果链（quiz_gen triggerEventId 同款）。
  const toolNames = resolveDomainToolNames(surface);
  const mcpServer = buildMcpServer({
    ctx: {
      db,
      signal: cancellationControl.signal,
      taskRunId,
      callerActor: { kind: 'agent', ref: actorRef },
      causedByEventId: runId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames,
    taskKind: 'CopilotTask',
    // C4 — tool-call hard ceiling（anti-runaway）。interceptInput 仅回传
    // warning 状态，不执行 capInput，故仍无 per-message row cap。
    beforeExecute: async (tool) =>
      (await cancellationControl.beforeTool()) ?? budgetTracker.beforeExecute(tool),
    onExecuteStart: (tool) => cancellationControl.onToolExecutionStarted(tool),
    onExecuteSettled: () => cancellationControl.onToolExecutionSettled(),
    interceptInput: (_tool, args) => ({
      args,
      truncationNote: budgetTracker.currentNotice(),
      softStop: null,
    }),
    onResult: (result) => {
      toolTrace.push(result);
    },
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
  const baseAllowedTools = [
    ...resolveMcpAllowedTools(surface),
    ...(tavilyCfg ? TAVILY_MCP_ALLOWED_TOOLS : []),
  ];
  const subagentEnabled = params.copilotSubagentEnabled ?? isCopilotSubagentEnabled(process.env);
  const allowedTools = [...baseAllowedTools, ...(subagentEnabled ? [SPAWN_TOOL_NAME] : [])];
  const spawnContract = subagentEnabled
    ? createSpawnContract({
        enabled: true,
        agents: buildCopilotSubagents({ parentAllowedTools: allowedTools }),
        onBudgetObservation: params.onSpawnBudgetObservation ?? observeCopilotSpawnBudget,
      })
    : undefined;
  const sdkHooks = cancellationControl.prependSdkHook(spawnContract?.hooks);

  // YUK-364 (bot-review C2) — 解析 copilot 对话方法论 SKILL.md 白名单（与 inline
  // 同一份 resolveCopilotSkills；cross-subject 共享 resolver）。命中 → 传 ctx.skills
  // 让整个 SKILL.md 行为包对 durable run 生效；缺包（undefined）→ ctx 省略 skills →
  // runner skills ?? [] 显式禁用 → registry.ts 散文兜底（never throws，与缺包现状
  // 零差异，spread-when-present 保 byte-compat）。
  const copilotSkills = await resolveSkills();

  // YUK-575 (A1/N3/MF-B) — 组装 FULL run input（与 inline byte-parity）。**pickup 时**
  // 重读 conversation_history / learner-state header(YUK-574) / proposal_feedback（保
  // 新鲜，不在 dispatch 侧冻结），传 historyAnchorEventId=runId，把历史固定在
  // dispatch 的 session + 插入边界（durable 时序 = dispatch-写-then-pickup）。
  // ambient RIDE 自 job payload（S4：request-only、从不 persisted，无处可重读）。
  const runInput: CopilotRunInput = await assembleRunInput(db, {
    sessionId: data.session_id,
    userMessage: data.user_message,
    triggeredBy: data.triggered_by,
    ...(data.chip_kind ? { chipKind: data.chip_kind } : {}),
    ...(data.ambient ? { ambient: data.ambient } : {}),
    now: new Date(),
    historyAnchorEventId: runId,
  });

  // YUK-575 (N2/S3) — STEP 进度继续用 FIFO promise-chain 落 job_events。
  // YUK-832 将模型正文完整缓冲：只有在 no-tool typed validator
  // pass/repair 并持久化 outcome marker 后，才能写安全 DELTA。
  // 否则后续 read tool 会使已经可见的伪因果文本无法撤回。
  let progressChain: Promise<void> = Promise.resolve();
  const enqueueProgress = (eventType: string, payload: Record<string, unknown>) => {
    progressChain = progressChain.then(async () => {
      // Progress is advisory and each write is independent. Keeping the catch
      // inside the link prevents one failed frame from poisoning later frames.
      try {
        await writeJobEvent(db, {
          business_table: COPILOT_RUN_TABLE,
          business_id: runId,
          event_type: eventType,
          payload,
        });
      } catch (err) {
        console.error('[copilot_run] progress write failed for', runId, err);
      }
    });
    return progressChain;
  };
  let candidateDeltaObserved = false;
  const onDelta = (text: string) => {
    if (text.length > 0) candidateDeltaObserved = true;
  };
  const projectSubtaskEvent = createCopilotSubtaskProjector();
  const onTaskEvent = subagentEnabled
    ? async (event: TaskEventMessage) => {
        const projected = projectSubtaskEvent(event);
        if (projected) {
          await enqueueProgress(COPILOT_RUN_EVENTS.STEP, { ...projected });
        }
      }
    : undefined;

  // Load-bearing execution fence, deliberately placed after every deterministic
  // setup/read and immediately before the only paid/external-effect gateway.
  // The claim rechecks under a per-run transaction lock: two overlapping
  // deliveries cannot both pass a replay-then-append TOCTOU and run tools twice.
  // A loser must NOT terminalize the run while the winner may still be live;
  // throwing lets pg-boss retry after the owner either persists DONE or crashes.
  const executionClaim = await claimExecutionFence(db, runId);
  if (executionClaim.outcome === 'terminal') {
    return terminalRunResult(executionClaim.events, taskRunId);
  }
  if (executionClaim.outcome === 'cancelled') return { status: 'cancelled' };
  if (executionClaim.outcome === 'existing') {
    return awaitClaimedCopilotExecution(params, Date.now() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS);
  }

  cancellationControl.startPolling();
  const cancellationMarker = (partialText?: string, providerTaskRunId?: string) => (tx: Tx) =>
    persistCopilotRunCancellationMarker(tx, {
      runId,
      sessionId: data.session_id,
      actorRef,
      ...(partialText ? { partialText } : {}),
      ...(providerTaskRunId ? { taskRunId: providerTaskRunId } : {}),
      checkpointSafe: !cancellationControl.materializingToolStarted,
      writeCopilotReplyFn: persistReply,
    });
  const settleObservedCancellation = async (partialText?: string, providerTaskRunId?: string) => {
    const drained = await cancellationControl.waitForInFlight(COPILOT_CANCEL_DRAIN_GRACE_MS);
    if (!drained) {
      return handleAmbiguousExecution(db, {
        runId,
        sessionId: data.session_id,
        actorRef,
        projectSuccessfulTerminal,
        projectFailedTerminal,
        writeCopilotReplyFn: persistReply,
      });
    }
    return handleDurableCancellation(db, {
      runId,
      sessionId: data.session_id,
      actorRef,
      ...(partialText ? { partialText } : {}),
      ...(providerTaskRunId ? { taskRunId: providerTaskRunId } : {}),
      checkpointSafe: !cancellationControl.materializingToolStarted,
      projectSuccessfulTerminal,
      projectFailedTerminal,
      writeCopilotReplyFn: persistReply,
    });
  };
  try {
    const result: StreamCollectResult = await streamRun(
      'CopilotTask',
      runInput,
      {
        db,
        signal: cancellationControl.signal,
        mcpServers,
        allowedTools,
        hooks: sdkHooks,
        ...(spawnContract
          ? {
              agents: spawnContract.agents,
              canUseTool: spawnContract.canUseTool,
            }
          : {}),
        ...(onTaskEvent ? { onTaskEvent } : {}),
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
    await drainDeltaChain(progressChain, runId);
    if ((await cancellationControl.probe()) === 'cancel_requested') {
      // The raw candidate has not passed evidence review and must not become a
      // cancellation partial after a read. A pure-text/no-reader partial keeps
      // the established Stop UX because no evidence-review claim is involved.
      const cancellationReply = toolTrace.some((entry) => entry.effect === 'read')
        ? undefined
        : result.text;
      return await settleObservedCancellation(cancellationReply, result.task_run_id);
    }

    const evidenceReview = await reviewEvidenceReply({
      db,
      requestContext: {
        user_message: data.user_message,
        surface,
        triggered_by: data.triggered_by,
        ...(data.chip_kind ? { chip_kind: data.chip_kind } : {}),
        ...(data.ambient ? { ambient_context: data.ambient } : {}),
      },
      candidateReply: result.text,
      candidateTaskRunId: result.task_run_id,
      toolTrace,
      signal: cancellationControl.signal,
      candidateComplete: !result.partial,
    });
    const reviewedReply = evidenceReview.replyText;

    // Stop can arrive while the second pass is running. The same AbortSignal
    // reaches the reviewer; re-probe before any domain reply or public suffix.
    if ((await cancellationControl.probe()) === 'cancel_requested') {
      return await settleObservedCancellation(reviewedReply, result.task_run_id);
    }

    // YUK-575 — streamTaskCollecting graceful-degrade：run 出错时它 resolve
    // { partial:true, error }（plain Error 内含）而非 throw。partial = run 跑了但失败
    // （可能有半程文本）→ terminal-no-retry（handleDurableFailure 写 failure marker +
    // FAILED(exhausted) 后 return）。只有 FAILED projection 写失败才交给 pg-boss；重投
    // 从 marker 修复终态，不会丢掉 partial 或重烧 paid work。
    if (result.partial) {
      return await handleDurableFailure(db, {
        err: new Error(result.error ?? 'run failed'),
        runId,
        sessionId: data.session_id,
        actorRef,
        partialText: reviewedReply,
        projectSuccessfulTerminal,
        projectFailedTerminal,
        writeCopilotReplyFn: persistReply,
        createCancelledMarker: cancellationMarker(reviewedReply, result.task_run_id),
        emitReviewedDelta: candidateDeltaObserved,
      });
    }

    // YUK-364 (F1) — commit the domain outcome marker first, then project the
    // public REPLY/DONE in a second transaction; both phases use the same
    // per-run settlement lock. A projection failure remains repairable from the
    // marker, while a recovery that wins first blocks a contradictory outcome.
    try {
      const markerClaim = await ensureCopilotOutcomeMarker(
        db,
        runId,
        async (tx) => {
          const { cleanedReply } = await persistReply(tx, {
            sessionId: data.session_id,
            userAskEventId: runId,
            replyText: reviewedReply,
            actorRef,
            taskRunId: result.task_run_id,
            outcome: 'success',
            durableFinishReason: result.finishReason,
            durableEmitReviewedDelta: candidateDeltaObserved,
            now: new Date(),
          });
          return {
            outcome: 'success' as const,
            replyMd: cleanedReply,
            taskRunId: result.task_run_id,
            finishReason: result.finishReason,
          };
        },
        { createCancelled: cancellationMarker(reviewedReply, result.task_run_id) },
      );
      if (markerClaim.outcome === 'already_terminal') {
        return terminalRunResult(markerClaim.events, taskRunId);
      }
      return await projectCopilotOutcomeMarker(
        db,
        runId,
        taskRunId,
        projectSuccessfulTerminal,
        projectFailedTerminal,
      );
    } catch (settlementErr) {
      throw new DurableTerminalProjectionError(runId, 'success', settlementErr);
    }
  } catch (err) {
    if (err instanceof DurableTerminalProjectionError) throw err;
    // streamTaskCollecting graceful-degrades（resolve partial，见上），故这里只捕获
    // 它之外的 throw（装配 / MCP mount / 事件写），或注入 fixture 的 throw（测 MF1/MF2）。
    await drainDeltaChain(progressChain, runId);
    if ((await cancellationControl.probe()) === 'cancel_requested') {
      return await settleObservedCancellation();
    }
    return await handleDurableFailure(db, {
      err,
      runId,
      sessionId: data.session_id,
      actorRef,
      projectSuccessfulTerminal,
      projectFailedTerminal,
      writeCopilotReplyFn: persistReply,
      createCancelledMarker: cancellationMarker(),
    });
  } finally {
    cancellationControl.dispose();
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

async function handleDurableCancellation(
  db: Db,
  args: PersistCopilotRunCancellationArgs & {
    writeCopilotReplyFn: typeof writeCopilotReply;
    projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn;
    projectFailedTerminal: WriteFailedTerminalProjectionFn;
  },
): Promise<RunCopilotRunResult> {
  try {
    const markerClaim = await ensureCopilotOutcomeMarker(db, args.runId, (tx) =>
      persistCopilotRunCancellationMarker(tx, args),
    );
    if (markerClaim.outcome === 'already_terminal') {
      return terminalRunResult(markerClaim.events, `copilot_run_tool_${args.runId}`);
    }
    return await projectCopilotOutcomeMarker(
      db,
      args.runId,
      `copilot_run_tool_${args.runId}`,
      args.projectSuccessfulTerminal,
      args.projectFailedTerminal,
    );
  } catch (projectionErr) {
    throw new DurableTerminalProjectionError(args.runId, 'failure', projectionErr);
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
 * 顺序：先写带 outcome=failure + 重建元数据的 copilot_reply durable marker
 * （partial 有文本则持久化半程文本，否则写聚焦重试提示，让 user_ask 不成
 * conversation_history 的 phantom），再写 load-bearing FAILED projection。若后一步
 * 失败则抛给 pg-boss；重投先命中 marker，只修复 FAILED，不重跑模型/工具，也不重复
 * conversation reply。完整 FAILED 后仍 return-without-throw，保持 single-shot 语义。
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
    projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn;
    projectFailedTerminal: WriteFailedTerminalProjectionFn;
    writeCopilotReplyFn: typeof writeCopilotReply;
    /** Settlement-lock race winner when Stop committed before this failure marker. */
    createCancelledMarker?: (tx: Tx) => Promise<PersistedDurableReply>;
    /** Persisted recovery flag for one reviewed full-text DELTA before FAILED. */
    emitReviewedDelta?: boolean;
  },
): Promise<RunCopilotRunResult> {
  const {
    err,
    runId,
    sessionId,
    actorRef,
    partialText,
    projectSuccessfulTerminal,
    projectFailedTerminal,
    writeCopilotReplyFn,
    createCancelledMarker,
    emitReviewedDelta,
  } = args;
  const message = String((err as Error)?.message ?? err);
  const replyText =
    partialText && partialText.length > 0
      ? partialText
      : '这次后台运行没能在预算内收敛完成。可以换个更聚焦的问法再试。';
  try {
    const markerClaim = await ensureCopilotOutcomeMarker(
      db,
      runId,
      async (tx) => {
        const { cleanedReply } = await writeCopilotReplyFn(tx, {
          sessionId,
          userAskEventId: runId,
          replyText,
          actorRef,
          taskRunId: `copilot_run_exhausted_${runId}`,
          outcome: 'failure',
          durableFailure: { reason: 'exhausted', error: message },
          durableEmitReviewedDelta: emitReviewedDelta,
          now: new Date(),
        });
        return {
          outcome: 'failure' as const,
          replyMd: cleanedReply,
          taskRunId: `copilot_run_exhausted_${runId}`,
          reason: 'exhausted' as const,
          error: message,
          ...(emitReviewedDelta ? { emitReviewedDelta: true } : {}),
        };
      },
      createCancelledMarker ? { createCancelled: createCancelledMarker } : {},
    );
    if (markerClaim.outcome === 'already_terminal') {
      return terminalRunResult(markerClaim.events, `copilot_run_tool_${runId}`);
    }
    return await projectCopilotOutcomeMarker(
      db,
      runId,
      `copilot_run_tool_${runId}`,
      projectSuccessfulTerminal,
      projectFailedTerminal,
    );
  } catch (projectionErr) {
    throw new DurableTerminalProjectionError(runId, 'failure', projectionErr);
  }
}

/**
 * Recover a redelivery whose paid/external execution may already have happened
 * but whose outcome marker is absent. Exactly-once cannot be reconstructed from
 * that state, so prefer at-most-once execution and tell the user the truth.
 */
async function handleAmbiguousExecution(
  db: Db,
  args: {
    runId: string;
    sessionId: string;
    actorRef: string;
    projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn;
    projectFailedTerminal: WriteFailedTerminalProjectionFn;
    writeCopilotReplyFn: typeof writeCopilotReply;
  },
): Promise<RunCopilotRunResult> {
  const {
    runId,
    sessionId,
    actorRef,
    projectSuccessfulTerminal,
    projectFailedTerminal,
    writeCopilotReplyFn,
  } = args;
  const error = 'execution outcome could not be confirmed after worker recovery';
  const replyText =
    '这次后台运行已经开始，但结果没有可靠保存。为避免重复执行可能已经发生的操作，我没有自动重跑；请先确认现有结果，再决定是否重新发起。';
  try {
    const markerClaim = await ensureCopilotOutcomeMarker(db, runId, async (tx) => {
      await writeCopilotReplyFn(tx, {
        sessionId,
        userAskEventId: runId,
        replyText,
        actorRef,
        taskRunId: `copilot_run_ambiguous_${runId}`,
        outcome: 'failure',
        durableFailure: { reason: 'ambiguous_execution', error },
        now: new Date(),
      });
      return {
        outcome: 'failure' as const,
        replyMd: replyText,
        taskRunId: `copilot_run_ambiguous_${runId}`,
        reason: 'ambiguous_execution' as const,
        error,
      };
    });
    if (markerClaim.outcome === 'already_terminal') {
      return terminalRunResult(markerClaim.events, `copilot_run_tool_${runId}`);
    }
    return await projectCopilotOutcomeMarker(
      db,
      runId,
      `copilot_run_tool_${runId}`,
      projectSuccessfulTerminal,
      projectFailedTerminal,
    );
  } catch (projectionErr) {
    throw new DurableTerminalProjectionError(runId, 'failure', projectionErr);
  }
}

export const COPILOT_RUN_QUEUE = 'copilot_run' as const;

export type CopilotDurableRunObservation =
  | 'settled'
  | 'projection_repaired'
  | 'queued'
  | 'waiting_on_active_run'
  | 'pickup_unavailable'
  | 'retrying'
  | 'running'
  | 'execution_settling'
  | 'pre_execution_lost'
  | 'ambiguous_execution'
  | 'unknown';

export interface ReconcileCopilotDurableRunParams {
  db: Db;
  runId: string;
  sessionId: string;
  triggeredBy: CopilotRunJobData['triggered_by'];
  bossJobId: string;
  pickupDeadlineMs?: number;
  /** One queue snapshot shared by the bounded sweep; used only for presentation. */
  queueActiveCount?: number;
  now?: Date;
  boss?: BossJobObserver;
  writeCopilotReplyFn?: typeof writeCopilotReply;
  writeSuccessfulTerminalProjectionFn?: WriteSuccessfulTerminalProjectionFn;
  writeFailedTerminalProjectionFn?: WriteFailedTerminalProjectionFn;
}

function liveObservation(
  queue: Extract<BossJobObservation, { kind: 'live' }>,
  params: ReconcileCopilotDurableRunParams,
  now: Date,
): 'running' | 'retrying' | 'queued' | 'waiting_on_active_run' | 'pickup_unavailable' | 'unknown' {
  if (queue.state === 'active') return 'running';
  if (queue.state === 'retry') return 'retrying';
  if (params.pickupDeadlineMs === undefined || now.getTime() <= params.pickupDeadlineMs) {
    return 'queued';
  }
  if (params.queueActiveCount === undefined) return 'unknown';
  return params.queueActiveCount > 0 ? 'waiting_on_active_run' : 'pickup_unavailable';
}

type LockedReconcileDecision =
  | { observation: Exclude<CopilotDurableRunObservation, 'projection_repaired'> }
  | { observation: 'marker_found' }
  | { observation: 'ambiguous_candidate' };

/**
 * Converge one accepted durable run without ever invoking model/tools.
 *
 * The dispatch lock makes the pre-execution decision atomic with both API
 * enqueue compensation and the worker's paid-execution fence. Once a fence
 * exists, recovery switches to the settlement lock already used by the paid
 * owner; only dead/missing pg-boss evidence and an expired owner budget may
 * produce `ambiguous_execution`. Legacy worker-touch evidence fails closed to
 * that path because those retained runs predate the explicit fence.
 */
export async function reconcileCopilotDurableRun(
  params: ReconcileCopilotDurableRunParams,
): Promise<CopilotDurableRunObservation> {
  const {
    db,
    runId,
    sessionId,
    triggeredBy,
    bossJobId,
    boss,
    writeCopilotReplyFn = writeCopilotReply,
    writeSuccessfulTerminalProjectionFn = writeSuccessfulTerminalProjection,
    writeFailedTerminalProjectionFn = writeFailedTerminalProjection,
  } = params;
  const now = params.now ?? new Date();
  const actorRef = selectActorRef(triggeredBy);
  const fallbackTaskRunId = `copilot_run_tool_${runId}`;

  // Cheapest repair first: a paid owner may have committed the domain marker
  // and lost only the public suffix. Re-project it without consulting pg-boss.
  const persisted = await findPersistedDurableReply(db, runId);
  if (persisted) {
    await projectCopilotOutcomeMarker(
      db,
      runId,
      fallbackTaskRunId,
      writeSuccessfulTerminalProjectionFn,
      writeFailedTerminalProjectionFn,
    );
    return 'projection_repaired';
  }

  const locked = await withCopilotDurableDispatchLock<LockedReconcileDecision>(
    db,
    runId,
    async (tx) => {
      const events = await tx
        .select({
          id: job_events.id,
          event_type: job_events.event_type,
          payload: job_events.payload,
          occurred_at: job_events.occurred_at,
        })
        .from(job_events)
        .where(
          and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
        )
        .orderBy(asc(job_events.id));
      if (hasCopilotSettlementTerminal(events)) return { observation: 'settled' };
      // A marker can appear after the optimistic read above. Never overwrite it
      // with delivery-loss copy; project its actual outcome after releasing Gd.
      if (await findPersistedDurableReply(tx, runId)) return { observation: 'marker_found' };

      const queue = await observeBossJob(COPILOT_RUN_QUEUE, bossJobId, {
        ...(boss ? { boss } : {}),
      });
      if (queue.kind === 'unknown') {
        console.error('[copilot_run_reconcile] queue observation unavailable', {
          runId,
          error: queue.error,
        });
        return { observation: 'unknown' };
      }
      if (queue.kind === 'live') {
        return { observation: liveObservation(queue, params, now) };
      }

      // Current deliveries carry an explicit execution fence. Retained legacy
      // runs do not, but STARTED/DELTA/STEP/REPLY/FAILED(error) still prove a
      // worker touched the run and model/tools may have run. Fail closed: only a
      // QUEUED-only history is safe to label pre-execution loss or revertible.
      const explicitFence = events.find(
        (event) => event.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      );
      const possibleExecutionEvidence =
        explicitFence ?? [...events].reverse().find(isDurableWorkerTouchEvent);
      if (possibleExecutionEvidence) {
        const ownerDeadlineMs =
          possibleExecutionEvidence.occurred_at.getTime() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS;
        return now.getTime() > ownerDeadlineMs
          ? { observation: 'ambiguous_candidate' }
          : { observation: 'execution_settling' };
      }

      const error = `pg-boss delivery ${queue.kind === 'missing' ? 'missing' : queue.state} before execution started`;
      const replyText =
        '这次后台运行在开始执行前失去了队列投递，没有调用模型或工具。请重新发送这个请求。';
      const taskRunId = `copilot_run_pre_execution_lost_${runId}`;
      await writeCopilotReplyFn(tx, {
        sessionId,
        userAskEventId: runId,
        replyText,
        actorRef,
        taskRunId,
        outcome: 'failure',
        durableFailure: { reason: 'pre_execution_lost', error },
        now,
      });
      await writeFailedTerminalProjectionFn(
        tx,
        { runId, reason: 'pre_execution_lost', error, replyMd: replyText },
        events,
      );
      return { observation: 'pre_execution_lost' };
    },
  );

  if (locked.observation === 'marker_found') {
    await projectCopilotOutcomeMarker(
      db,
      runId,
      fallbackTaskRunId,
      writeSuccessfulTerminalProjectionFn,
      writeFailedTerminalProjectionFn,
    );
    return 'projection_repaired';
  }
  if (locked.observation !== 'ambiguous_candidate') return locked.observation;

  const result = await handleAmbiguousExecution(db, {
    runId,
    sessionId,
    actorRef,
    projectSuccessfulTerminal: writeSuccessfulTerminalProjectionFn,
    projectFailedTerminal: writeFailedTerminalProjectionFn,
    writeCopilotReplyFn,
  });
  return result.status === 'done' ? 'projection_repaired' : 'ambiguous_execution';
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
      // Malformed payload must fail the physical delivery. Returning here tells
      // pg-boss "completed" and leaves the accepted public run non-terminal
      // forever. Retries/failed queue evidence lets the reconciler settle it as
      // pre_execution_lost without inventing a partial result.
      if (!data?.run_id || !data?.session_id || !data?.user_message || !data?.triggered_by) {
        throw new Error(
          `copilot_run job ${job.id} missing run_id/session_id/user_message/triggered_by`,
        );
      }
      const result = await runCopilotRun({ db, data });
      console.log(`[copilot_run] ${data.run_id} -> ${result.status}`);
    }
  };
}
