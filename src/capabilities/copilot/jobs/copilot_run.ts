// Copilot's single persistent execution owner (ADR-0062).
// HTTP admission commits the input and queues its session head; this worker
// owns execution, Stop, native session reuse and the live paid/tool loop. Safe
// STEP progress and provider prose publish during execution; authoritative
// reply replacement follows the finalized domain outcome commit. Closing a
// subscriber cannot cancel it.
// Input/reply writes live in conversation-writes; the execution/finalization
// policy lives in copilot-execution. Registered tools come from capability
// manifests before worker pickup, never from an extra chat adapter.
// Every terminalizing write — the two pre-execution gates, the outcome marker
// two-phase, the public REPLY/DONE/FAILED receipt and all recovery decisions —
// belongs to server/copilot-run-settlement.ts; this owner only feeds its paid
// outcome into that settlement operation.

import { createHash } from 'node:crypto';
import type { Job } from 'pg-boss';
import { observeTaskOperation } from '@/ai/task-observation';
import {
  type PreparedCopilotReply,
  writeCopilotReply,
  writeTeachingCopilotReply,
} from '@/capabilities/copilot/server/conversation-writes';
import {
  COPILOT_CANCEL_DRAIN_GRACE_MS,
  type CopilotRunCancellationControl,
  copilotPartialReply,
  createCopilotRunCancellationControl,
  persistCopilotRunCancellationMarker,
} from '@/capabilities/copilot/server/copilot-run-cancellation';
// YUK-575 (A1/N3) — the shared free-form run-input assembler. The durable handler
// assembles the FULL run input at pickup time (YUK-596: pass run_id as a causal
// history anchor in the job's fixed session; conversation_history / learner-state
// header / proposal_feedback / ambient all fresh at pickup), byte-parity with
// inline. Before YUK-575 the durable run shipped a minimal {surface,triggered_by,
// user_message} with NO session memory.
import {
  type CopilotRunInput,
  assembleCopilotRunInput,
  selectActorRef,
  selectSurface,
} from '@/capabilities/copilot/server/copilot-run-input';
import {
  captureWorkerSessionCursor,
  commitWorkerSessionCursor,
  selectResumableWorkerSession,
} from '@/capabilities/copilot/server/copilot-run-session-cursor';
import {
  type ClaimCopilotExecutionFenceFn,
  DURABLE_OWNER_SETTLEMENT_BUDGET_MS,
  DurableTerminalProjectionError,
  type RunCopilotRunResult,
  type WriteFailedTerminalProjectionFn,
  type WriteSuccessfulTerminalProjectionFn,
  claimCopilotExecutionFence,
  ensureCopilotOutcomeMarker,
  handleAmbiguousExecution,
  handleDurableCancellation,
  handleDurableFailure,
  hasCopilotSettlementTerminal,
  markCopilotRunStarted,
  projectCopilotOutcomeMarker,
  publishCopilotRunProgressEvent,
  terminalRunResult,
  withCopilotExecutionSettlementLock,
  writeFailedTerminalProjection,
  writeSuccessfulTerminalProjection,
} from '@/capabilities/copilot/server/copilot-run-settlement';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  isCopilotRunTerminalEvent,
} from '@/capabilities/copilot/server/copilot-run-status';
import { acceptedCopilotDerivationPolicy } from '@/capabilities/copilot/server/derivation-policy';
import {
  type CopilotRunJobData,
  hasTerminalCopilotRun,
} from '@/capabilities/copilot/server/durable-dispatch';
import { runTeachingSkill } from '@/capabilities/copilot/server/skills/teaching-skill';
import { reconcileNativeSubagentsForParent } from '@/capabilities/copilot/server/subagent-mailbox';
import { classifyCrisisExpression, crisisTemplateForClass } from '@/core/crisis/classify';
import type { Db, Tx } from '@/db/client';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import type { ModelBinding } from '@/server/ai/execution-adapter';
import { computeReplay } from '@/server/events/sse_replay';
import {
  DURABLE_COPILOT_EXECUTION_BUDGET,
  type ExecuteCopilotTurn,
  executeCopilotTurn,
} from '../server/copilot-execution';
import { findPersistedDurableReply } from '../server/copilot-run-outcome';
import { resolveCopilotModeCompletion } from '../server/mode-completion';
import type { CopilotReplyFinalizationReceipt } from '../server/reply-finalization';
import type { SpawnBudgetObservation } from '../server/subagents';
import { projectCopilotActivity } from '../server/tool-activity';

export type {
  CopilotDurableRunObservation,
  ReconcileCopilotDurableRunParams,
  RunCopilotRunResult,
  TerminalProjectionEvent,
  WriteFailedTerminalProjectionFn,
  WriteSuccessfulTerminalProjectionFn,
} from '@/capabilities/copilot/server/copilot-run-settlement';
// Compatibility surface: the settlement owner moved to server/copilot-run-settlement;
// existing callers keep importing these symbols from this job module.
export {
  CLAIMED_EXECUTION_SETTLE_GRACE_MS,
  COPILOT_RUN_QUEUE,
  DURABLE_OWNER_SETTLEMENT_BUDGET_MS,
  claimCopilotExecutionFence,
  hasCopilotSettlementTerminal,
  markCopilotRunStarted,
  reconcileCopilotDurableRun,
  writeFailedTerminalProjection,
  writeSuccessfulTerminalProjection,
} from '@/capabilities/copilot/server/copilot-run-settlement';
export type { CopilotRunJobData } from '../server/durable-dispatch';

// One execution owner resolves the budget. Copilot spend ceilings were removed
// by owner directive — turns and tool calls are uncapped; the 45-minute
// wall-clock window remains as the owner-recovery bound and stays below the
// stuck-run sweeper threshold (STUCK_RUN_THRESHOLD_MS = 1h, asserted in tests).
export const DURABLE_BUDGET = DURABLE_COPILOT_EXECUTION_BUDGET;

export interface RunCopilotRunParams {
  db: Db;
  data: CopilotRunJobData;
  /** One semantic AI seam; SDK/MCP/finalization assembly belongs to Copilot execution. */
  executeCopilotTurnFn?: ExecuteCopilotTurn;
  runTeachingSkillFn?: typeof runTeachingSkill;
  /**
   * YUK-575 (A1/N3) test seam — 默认 assembleCopilotRunInput。注入 fixture 断言
   * pickup-time 装配参数（historyAnchorEventId=run_id、ambient 透传等）而不打真 DB。
   */
  resolveCopilotRunInputFn?: typeof assembleCopilotRunInput;
  /** Test/ops seam for the default-on COPILOT_SUBAGENT_ENABLED kill switch. */
  copilotSubagentEnabled?: boolean;
  /** Per-run provider/model pin (actual-output evidence gate; prod omits). */
  modelBinding?: ModelBinding;
  /** Report-only observation seam; native tool-call/cost logs remain authoritative. */
  onSpawnBudgetObservation?: (observation: SpawnBudgetObservation) => void;
  /** Test seam for the transactional REPLY+DONE projection and redelivery repair. */
  writeSuccessfulTerminalProjectionFn?: WriteSuccessfulTerminalProjectionFn;
  /** Test seam for the FAILED projection and redelivery repair. */
  writeFailedTerminalProjectionFn?: WriteFailedTerminalProjectionFn;
  /** Test seam for the domain outcome marker written after paid execution. */
  writeCopilotReplyFn?: typeof writeCopilotReply;
  /** Test seam for the load-bearing atomic paid-execution claim. */
  claimExecutionFenceFn?: ClaimCopilotExecutionFenceFn;
  /** Test seam for the cross-process cancellation observer/controller. */
  createCancellationControlFn?: typeof createCopilotRunCancellationControl;
}

const CLAIMED_EXECUTION_POLL_MS = 250;

/**
 * An overlapping physical delivery must neither execute nor declare the live
 * owner ambiguous. Wait within the 2h pg-boss lease for the primary + final
 * finalization + settlement owner budget, then re-enter through normal replay guards. If the owner crashed,
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
  return observeTaskOperation(
    { operation: 'run', taskKind: 'CopilotTask', logicalRunId: params.data.run_id },
    async (reportOutcome) => {
      const result = await runCopilotRunImpl(params);
      reportOutcome(
        result.status === 'done'
          ? 'accepted'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'rejected',
      );
      return result;
    },
  );
}

async function runCopilotRunImpl(params: RunCopilotRunParams): Promise<RunCopilotRunResult> {
  try {
    return await executeAcceptedCopilotRun(params);
  } finally {
    // Includes replay/early exits and persisted markers whose public suffix
    // failed. No terminal means no repair; projection failure cannot undo a
    // paid parent outcome. The existing parent reconciler retries after crashes.
    try {
      // R1 cleanup：只在 allow 回合结算原生子代理；任何受限用途
      // （answer_only / crisis）都不该有原生代子代要收敛。
      if ((await readEventDerivationPolicy(params.db, params.data.run_id)) === 'allow') {
        await reconcileNativeSubagentsForParent(
          params.db,
          params.data.session_id,
          params.data.run_id,
        );
      }
    } catch (error) {
      console.error('[copilot_run] native child settlement failed', {
        runId: params.data.run_id,
        error,
      });
    }
  }
}

async function executeAcceptedCopilotRun(
  params: RunCopilotRunParams,
): Promise<RunCopilotRunResult> {
  const { db, data } = params;
  const derivationPolicy = await acceptedCopilotDerivationPolicy(db, data);
  const answerOnly = derivationPolicy === 'answer_only';
  const execute = params.executeCopilotTurnFn ?? executeCopilotTurn;
  const assembleRunInput = params.resolveCopilotRunInputFn ?? assembleCopilotRunInput;
  const runId = data.run_id;
  const surface = selectSurface(data.triggered_by);
  const actorRef = selectActorRef(data.triggered_by);
  const baseTaskRunId = `copilot_run_tool_${runId}`;
  const projectSuccessfulTerminal =
    params.writeSuccessfulTerminalProjectionFn ?? writeSuccessfulTerminalProjection;
  const projectFailedTerminal =
    params.writeFailedTerminalProjectionFn ?? writeFailedTerminalProjection;
  const persistReply = params.writeCopilotReplyFn ?? writeCopilotReply;
  const claimExecutionFence = params.claimExecutionFenceFn ?? claimCopilotExecutionFence;
  const createCancellationControl =
    params.createCancellationControlFn ?? createCopilotRunCancellationControl;
  const discardWorkerCursor = await captureWorkerSessionCursor(db, data.session_id);

  // 启动前 replay 一次：F3 terminal-already-present 守卫 + pre-fence 协作取消。
  // 运行中 Stop 由下方 cancellation control 的 poll / SDK hook / DomainTool gate
  // 接管；run handle 是 run_id，所有请求/终态仍写进同一 business_id。
  const priorEvents = await computeReplay(db, {
    businessTable: COPILOT_RUN_TABLE,
    businessId: runId,
    lastEventId: 0,
  });
  // Legacy FAILED(reason=error) frames explicitly authorize another paid
  // delivery. Each such delivery needs a fresh model-attempt identity: both
  // ai_task_runs and provider_session_admission are terminal ledgers keyed by
  // task_run_id and must never be reopened. The replay count is deterministic
  // across overlapping/redelivered workers; the execution fence below still
  // guarantees that only one owner can use this candidate identity.
  const retryableFailureCount = priorEvents.filter(
    (event) => event.event_type === COPILOT_RUN_EVENTS.FAILED && !isCopilotRunTerminalEvent(event),
  ).length;
  const taskRunId =
    retryableFailureCount === 0 ? baseTaskRunId : `${baseTaskRunId}_retry_${retryableFailureCount}`;

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
    return terminalRunResult(priorEvents, taskRunId);
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
  // YUK-1398（S3）— crisis 回合的确定性终局：不逃模型、不调工具、不进
  // 执行 fence。分类在接纳点完成（chat.ts），策略经既有投递链验证送达
  // （acceptedCopilotDerivationPolicy）；此处用同一确定性词法重选模板
  // （输入已验证 ask.payload.user_message === data.user_message，同类同案）。
  // 回复经 persistReply 写入：继承 ask 的 crisis 策略（连同直接上下文被
  // 一切派生读面排除）；REPLY/DONE 投影带 finish_reason='crisis_template'。
  // 模板正文见 src/core/crisis/config.ts（每条带 review_status，当前全部未审定）。
  if (derivationPolicy === 'crisis') {
    const detectionClass = classifyCrisisExpression(data.user_message);
    // 四类各有模板（R1 fix 3 拆分后）；'none'（客户端自送策略的 fail-safe）
    // 按 explicit → full_support，不过度也不漏。
    const template = crisisTemplateForClass(
      detectionClass === 'none' ? 'explicit' : detectionClass,
    );
    const crisisTaskRunId = `copilot_run_crisis_${runId}`;
    const settlement = await withCopilotExecutionSettlementLock(
      db,
      runId,
      async (tx, lockedEvents) => {
        await persistReply(tx, {
          sessionId: data.session_id,
          userAskEventId: runId,
          replyText: template.text_md,
          actorRef,
          taskRunId: crisisTaskRunId,
          outcome: 'success',
          durableFinishReason: 'crisis_template',
          now: new Date(),
        });
        await projectSuccessfulTerminal(
          tx,
          {
            runId,
            replyMd: template.text_md,
            taskRunId: crisisTaskRunId,
            finishReason: 'crisis_template',
          },
          lockedEvents,
        );
        return {
          status: 'done' as const,
          reply: template.text_md,
          task_run_id: crisisTaskRunId,
        };
      },
    );
    return settlement.outcome === 'settled'
      ? settlement.value
      : terminalRunResult(settlement.events, crisisTaskRunId);
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
  const started = await markCopilotRunStarted(
    db,
    runId,
    {
      surface,
      triggered_by: data.triggered_by,
    },
    { beforeCancelled: answerOnly ? undefined : discardWorkerCursor },
  );
  if (started.outcome === 'terminal') return terminalRunResult(started.events, taskRunId);
  if (started.outcome === 'cancelled') {
    return { status: 'cancelled' };
  }

  // YUK-575 (A1/N3/MF-B) — 组装 FULL run input（与 inline byte-parity）。**pickup 时**
  // 重读 conversation_history / learner-state header(YUK-574) / proposal_feedback（保
  // 新鲜，不在 dispatch 侧冻结），传 historyAnchorEventId=runId，把历史固定在
  // dispatch 的 session + 插入边界（durable 时序 = dispatch-写-then-pickup）。
  // ambient RIDE 自 job payload（S4：request-only、从不 persisted，无处可重读）。
  const runInput: CopilotRunInput = await assembleRunInput(db, {
    sessionId: data.session_id,
    userMessage: data.user_message,
    derivationPolicy,
    triggeredBy: data.triggered_by,
    ...(data.chip_kind ? { chipKind: data.chip_kind } : {}),
    ...(data.ambient ? { ambient: data.ambient } : {}),
    ...(data.correction_target_turn_id
      ? { correctionTargetTurnId: data.correction_target_turn_id }
      : {}),
    now: new Date(),
    historyAnchorEventId: runId,
  });
  const resumeSessionId = await selectResumableWorkerSession(db, data.session_id, answerOnly);
  let progressChain: Promise<void> = Promise.resolve();
  let streamedProse = '';
  const toolSummaries: string[] = [];
  const partialReply = () => copilotPartialReply({ prose: streamedProse, toolSummaries });
  const displayedProse = (): string | undefined =>
    streamedProse.trim().length > 0 ? streamedProse : undefined;
  const stopPartialText = (explicit?: string): string | undefined =>
    explicit !== undefined && explicit.length > 0 ? explicit : displayedProse();
  // Load-bearing execution fence, deliberately placed after every deterministic
  // setup/read and immediately before the only paid/external-effect gateway.
  // The claim rechecks under a per-run transaction lock: two overlapping
  // deliveries cannot both pass a replay-then-append TOCTOU and run tools twice.
  // A loser must NOT terminalize the run while the winner may still be live;
  // throwing lets pg-boss retry after the owner either persists DONE or crashes.
  const executionClaim = await claimExecutionFence(db, runId, {
    beforeCancelled: answerOnly ? undefined : discardWorkerCursor,
    beforeExecution: answerOnly ? discardWorkerCursor : undefined,
  });
  if (executionClaim.outcome === 'terminal') {
    return terminalRunResult(executionClaim.events, taskRunId);
  }
  if (executionClaim.outcome === 'cancelled') {
    return { status: 'cancelled' };
  }
  if (executionClaim.outcome === 'existing') {
    return awaitClaimedCopilotExecution(params, Date.now() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS);
  }

  const cancellationControl: CopilotRunCancellationControl = createCancellationControl({
    db,
    runId,
  });
  cancellationControl.startPolling();
  const cancellationMarker =
    (
      partialText?: string,
      providerTaskRunId?: string,
      replyFinalization?: CopilotReplyFinalizationReceipt,
      preparedReply?: PreparedCopilotReply,
    ) =>
    (tx: Tx) => {
      const partial = stopPartialText(partialText);
      return persistCopilotRunCancellationMarker(tx, {
        runId,
        sessionId: data.session_id,
        actorRef,
        ...(partial ? { partialText: partial } : {}),
        ...(providerTaskRunId ? { taskRunId: providerTaskRunId } : {}),
        ...(replyFinalization ? { replyFinalization } : {}),
        ...(preparedReply ? { preparedReply } : {}),
        toolSummaries,
        checkpointSafe: !cancellationControl.materializingToolStarted,
        writeCopilotReplyFn: persistReply,
      });
    };
  const settleObservedCancellation = async (
    partialText?: string,
    providerTaskRunId?: string,
    replyFinalization?: CopilotReplyFinalizationReceipt,
    preparedReply?: PreparedCopilotReply,
  ) => {
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
    const stopText = stopPartialText(partialText);
    return handleDurableCancellation(db, {
      runId,
      sessionId: data.session_id,
      actorRef,
      ...(stopText ? { partialText: stopText } : {}),
      ...(providerTaskRunId ? { taskRunId: providerTaskRunId } : {}),
      ...(replyFinalization ? { replyFinalization } : {}),
      ...(preparedReply ? { preparedReply } : {}),
      toolSummaries,
      checkpointSafe: !cancellationControl.materializingToolStarted,
      projectSuccessfulTerminal,
      projectFailedTerminal,
      writeCopilotReplyFn: persistReply,
    });
  };
  try {
    if (answerOnly && data.skill_context?.skill === 'teaching') {
      throw new Error('仅用于本次回答：不能创建教学练习。请重新提交需要用于日常学习的内容。');
    }
    if (data.skill_context?.skill === 'teaching') {
      const skillContext = data.skill_context;
      const skillResult = await (params.runTeachingSkillFn ?? runTeachingSkill)({
        db,
        sessionId: data.session_id,
        learningItemId: skillContext.ref.id,
        userMessage: data.user_message,
        taskRunId,
        signal: cancellationControl.signal,
        providerSessionDeadlineAt: Date.now() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS,
      });
      if ((await cancellationControl.probe()) === 'cancel_requested')
        return await settleObservedCancellation();
      try {
        const markerClaim = await ensureCopilotOutcomeMarker(
          db,
          runId,
          async (tx) => {
            const committed = await writeTeachingCopilotReply(tx, {
              sessionId: data.session_id,
              userAskEventId: runId,
              actorRef,
              skillContext,
              skillResult,
              outcome: 'success',
              durableFinishReason: 'end_turn',
              now: new Date(),
            });
            return {
              outcome: 'success' as const,
              replyMd: committed.cleanedReply,
              taskRunId: skillResult.task_run_id,
              finishReason: 'end_turn',
              modeState: { skill_turn: committed.skillTurn, skill_context: skillContext },
            };
          },
          { createCancelled: cancellationMarker() },
        );
        if (markerClaim.outcome === 'already_terminal')
          return terminalRunResult(markerClaim.events, taskRunId);
        return await projectCopilotOutcomeMarker(
          db,
          runId,
          skillResult.task_run_id,
          projectSuccessfulTerminal,
          projectFailedTerminal,
        );
      } catch (error) {
        throw new DurableTerminalProjectionError(runId, 'success', error);
      }
    }
    const result = await execute(
      db,
      {
        input: runInput,
        sessionId: data.session_id,
        taskRunId,
        sourceEventId: runId,
      },
      {
        cancellation: cancellationControl,
        deadlineAt: Date.now() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS,
        ...(params.modelBinding ? { modelBinding: params.modelBinding } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(params.copilotSubagentEnabled !== undefined
          ? { subagentsEnabled: params.copilotSubagentEnabled }
          : {}),
        observe: (activity) => {
          if (activity.kind === 'tool_finished' && activity.summary.trim().length > 0) {
            toolSummaries.push(`${activity.toolName}: ${activity.summary.trim()}`);
          }
          if (activity.kind === 'spawn_budget') {
            params.onSpawnBudgetObservation?.(activity.observation);
            return;
          }
          const isProse = activity.kind === 'prose_delta';
          const payload = isProse ? { text: activity.text } : projectCopilotActivity(activity);
          if (!payload) return;
          progressChain = progressChain
            .catch(() => undefined)
            .then(async () => {
              // Stop and terminal commits share the settlement lock. A queued
              // delta cannot cross either boundary, even when persistence lags
              // the provider; the boundary rule lives in the settlement owner.
              await publishCopilotRunProgressEvent(
                db,
                runId,
                isProse ? { kind: 'delta', text: activity.text } : { kind: 'step', payload },
                isProse
                  ? (text) => {
                      streamedProse += text;
                    }
                  : undefined,
              );
            });
          return progressChain;
        },
      },
    );
    await drainDeltaChain(progressChain, runId);
    const finalized = result.finalization;
    const finalReply = finalized.replyText;
    const preparedReply: PreparedCopilotReply = finalized.preparedReply;
    const cancellationReply = finalized.accepted ? finalReply : undefined;
    if ((await cancellationControl.probe()) === 'cancel_requested') {
      return await settleObservedCancellation(
        cancellationReply,
        result.taskRunId,
        finalized.accepted ? finalized.receipt : undefined,
        finalized.accepted ? finalized.preparedReply : undefined,
      );
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
        taskRunId: result.taskRunId,
        partialText: partialReply() ?? finalReply,
        preparedReply,
        projectSuccessfulTerminal,
        projectFailedTerminal,
        writeCopilotReplyFn: persistReply,
        replyFinalization: finalized.receipt,
        createCancelledMarker: cancellationMarker(
          cancellationReply,
          result.taskRunId,
          finalized.accepted ? finalized.receipt : undefined,
          finalized.accepted ? finalized.preparedReply : undefined,
        ),
      });
    }

    if (!finalized.accepted) {
      return await handleDurableFailure(db, {
        err: new Error('root terminal reply rejected'),
        runId,
        sessionId: data.session_id,
        actorRef,
        taskRunId: result.taskRunId,
        partialText: partialReply() ?? finalReply,
        preparedReply,
        projectSuccessfulTerminal,
        projectFailedTerminal,
        writeCopilotReplyFn: persistReply,
        replyFinalization: finalized.receipt,
        createCancelledMarker: cancellationMarker(),
      });
    }

    const modeState = resolveCopilotModeCompletion(data.skill_context, {
      kind: 'success',
    });

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
            replyText: finalReply,
            preparedReply,
            actorRef,
            taskRunId: result.taskRunId,
            replyFinalization: finalized.receipt,
            outcome: 'success',
            durableFinishReason: result.finishReason,
            ...(modeState ? { modeState } : {}),
            now: new Date(),
          });
          const candidateMatchesCommitted =
            finalized.receipt.candidate_sha256 ===
            createHash('sha256').update(cleanedReply, 'utf8').digest('hex');
          if (!answerOnly && result.sdkSessionId && candidateMatchesCommitted) {
            // The settlement lock still prevents terminal publication and successor pickup.
            await commitWorkerSessionCursor(
              tx,
              data.session_id,
              result.sdkSessionId,
              result.contextDigest,
            );
          } else if (!answerOnly) {
            await discardWorkerCursor(tx);
          }
          return {
            outcome: 'success' as const,
            replyMd: cleanedReply,
            taskRunId: result.taskRunId,
            finishReason: result.finishReason,
            ...(modeState ? { modeState } : {}),
            ...(preparedReply.primaryView ? { primaryView: preparedReply.primaryView } : {}),
          };
        },
        {
          createCancelled: cancellationMarker(
            cancellationReply,
            result.taskRunId,
            finalized.accepted ? finalized.receipt : undefined,
            finalized.accepted ? finalized.preparedReply : undefined,
          ),
        },
      );
      if (markerClaim.outcome === 'already_terminal') {
        return terminalRunResult(markerClaim.events, taskRunId);
      }
      const projected = await projectCopilotOutcomeMarker(
        db,
        runId,
        taskRunId,
        projectSuccessfulTerminal,
        projectFailedTerminal,
      );
      return projected;
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
      partialText: partialReply(),
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

/**
 * pg-boss handler 工厂（JobHandlerFactory 形态 `(db) => (jobs) => Promise<void>`）。
 * 注册器（register-capability-jobs.ts）固定 { pollingIntervalSeconds:2, batchSize:1 }
 * → 天然 n=1 单线程一次一 run（串行化由 batchSize:1 提供）。
 */
export function buildCopilotRunHandler(
  db: Db,
  options: { wakeSession: (sessionId: string) => Promise<unknown> },
): (jobs: Job<CopilotRunJobData>[]) => Promise<void> {
  const { wakeSession } = options;
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
      try {
        const result = await runCopilotRun({ db, data });
        console.log(`[copilot_run] ${data.run_id} -> ${result.status}`);
      } finally {
        // Only after the terminal transaction has committed may the successor
        // run start. A wake failure never invalidates an already-paid outcome;
        // the existing reconciler provides the durable retry floor.
        try {
          if (await hasTerminalCopilotRun(db, data.run_id)) await wakeSession(data.session_id);
        } catch (error) {
          console.error('[copilot_run] successor wake deferred to reconciliation', {
            runId: data.run_id,
            error,
          });
        }
      }
    }
  };
}
