import type { Db } from '@/db/client';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/kernel/tools/allowlists';
import { resolveContextBudget } from '@/kernel/tools/budgets';
import { ContextBudgetTracker } from '@/kernel/tools/context-throttle';
import type { ValidateLearningContentFn } from '@/kernel/tools/types';
import type { ModelBinding } from '@/server/ai/execution-adapter';
import {
  EXA_MCP_ALLOWED_TOOLS,
  EXA_MCP_SERVER_NAME,
  EXA_SCOPED_TOOL_NAMES,
  buildExaMcpServer,
} from '@/server/ai/mcp/exa';
import type { PiAfterToolCall } from '@/server/ai/pi-hooks';
import {
  type RunTaskResult,
  type StreamCollectResult,
  runAgentTask,
  streamTaskCollecting,
} from '@/server/ai/runner';
import {
  type BuildMcpServerOptions,
  shouldEmitToolUseForCaller,
} from '@/server/ai/tools/mcp-bridge';
import {
  type RemoteMcpHttpConfig,
  piDomainMount,
  piRemoteMcpMount,
} from '@/server/ai/tools/pi-tools';
import { resolveCopilotSkillDocs } from '@/subjects/copilot-skills';
import { reviewCopilotLearningContent } from './content-validation';
import type { CopilotRunCancellationControl } from './copilot-run-cancellation';
import type { CopilotRunInput } from './copilot-run-input';
import { selectActorRef } from './copilot-run-input';
import { clearCopilotWorkerSession } from './copilot-worker-session';
import { resolveDeterministicCorrectionContract } from './correction-contract';
import {
  copilotSessionContextDigest,
  shouldDeliverCopilotSessionContext,
} from './live-session-context';
import {
  COPILOT_TURN_CONTEXT_CODEC_VERSION,
  compileCopilotModelInput,
  compileCopilotSessionContext,
} from './live-turn-context';
import { validateLearningContent as validatePreparedLearningContent } from './practice-port';
import { resolveLivePrimaryViewArtifact } from './primary-view-reference';
import { createCopilotProposalFlowGate } from './proposal-flow-gate';
import {
  type CopilotReplyFinalizationResult,
  createCopilotReplyFinalizer,
  piToolErrorText,
  prependCopilotPiFinalizationHooks,
  primaryViewLearningContent,
  primaryViewLearningQuestions,
} from './reply-finalization';
import { bindSubagentParentCancellation, handleNativeSubagentTaskEvent } from './subagent-mailbox';
import {
  type CopilotSubtaskEvent,
  type CopilotTaskLifecycleMessage,
  type SpawnBudgetObservation,
  buildCopilotNativeResearchConfig,
  createCopilotSubtaskProjector,
  isCopilotSubagentEnabled,
} from './subagents';

/**
 * Durable Copilot runs carry NO quantity ceilings — owner directive removes all
 * spend caps (agentic turns, tool calls, row budgets are uncapped; the Copilot
 * context-budget surface keeps advisory warnings only). What remains is the
 * wall-clock execution window, which exists for owner recovery, not cost:
 * `timeoutMs` doubles as the basis of DURABLE_OWNER_SETTLEMENT_BUDGET_MS in
 * copilot_run.ts, and it MUST stay finite and strictly below
 * STUCK_RUN_THRESHOLD_MS (1h) or the stuck-run sweeper would converge a live
 * execution. 45min leaves the sweeper a ~14.5min margin.
 */
export const DURABLE_COPILOT_EXECUTION_BUDGET = {
  /** 'unbounded' maps to no `shouldStopAfterTurn` on the pi lane — turns are
   *  limited only by explicit Stop, cancellation, or the timeout below. */
  maxIterations: 'unbounded',
  timeoutMs: 45 * 60_000,
} as const;

/**
 * The wire-name predicate for hosted-MCP calls (Exa today): any `mcp__` tool
 * not served by the in-process domain mount. Kept identical to the
 * remote-evidence predicate in reply-finalization.ts.
 */
export function isRemoteMcpToolCall(name: string): boolean {
  return name.startsWith('mcp__') && !name.startsWith(`mcp__${DOMAIN_TOOL_MCP_SERVER_NAME}__`);
}

export type CopilotExecutionActivity =
  | { kind: 'subtask'; event: CopilotSubtaskEvent }
  | {
      kind: 'tool_started';
      toolName: string;
      input: Record<string, unknown>;
      toolUseId?: string;
    }
  | {
      kind: 'tool_finished';
      toolName: string;
      input: Record<string, unknown>;
      summary: string;
      errorReason?: string;
      toolUseId?: string;
    }
  | { kind: 'spawn_budget'; observation: SpawnBudgetObservation };

export interface CopilotExecutionTurn {
  input: CopilotRunInput;
  sessionId: string;
  taskRunId: string;
  /** User ask/chip event that owns tool mirrors and native child records. */
  sourceEventId?: string;
}

export interface CopilotExecutionPolicy {
  /** The accepted run owns polling/settlement; this module owns propagation. */
  cancellation: CopilotRunCancellationControl;
  deadlineAt: number;
  /**
   * Per-run provider/model pin (actual-output evidence gates, ops override).
   * Threads verbatim into the runner ctx — resolveTaskProvider ordering
   * (explicit > env > registry) is unchanged.
   */
  modelBinding?: ModelBinding;
  resumeSessionId?: string;
  subagentsEnabled?: boolean;
  observe?: (activity: CopilotExecutionActivity) => Promise<void> | void;
}

export interface CopilotExecutionResult {
  taskRunId: string;
  finishReason: string;
  finalization: CopilotReplyFinalizationResult;
  partial: boolean;
  error?: string;
  candidateDeltaObserved: boolean;
  sdkSessionId?: string;
  contextDigest: string;
}

export type ExecuteCopilotTurn = (
  db: Db,
  turn: CopilotExecutionTurn,
  policy: CopilotExecutionPolicy,
) => Promise<CopilotExecutionResult>;

type AgentResult = Pick<RunTaskResult, 'task_run_id' | 'text'> & { finishReason?: string };
type StreamResult = Pick<
  StreamCollectResult,
  'task_run_id' | 'text' | 'terminalText' | 'partial' | 'error'
> & { finishReason?: string };

/** Process-level adapters. Product callers use ExecuteCopilotTurn, never this seam. */
export interface CopilotExecutionAdapters {
  runAgentTaskFn: (
    kind: string,
    input: unknown,
    ctx: Parameters<typeof runAgentTask>[2],
  ) => Promise<AgentResult>;
  streamTaskCollectingFn: (
    kind: string,
    input: unknown,
    ctx: Parameters<typeof streamTaskCollecting>[2],
    onDelta: (text: string) => void,
  ) => Promise<StreamResult>;
  buildExaMcpServerFn: () => RemoteMcpHttpConfig | null;
  /** Resolved SKILL.md bodies for system-prompt injection. */
  resolveCopilotSkillDocsFn: typeof resolveCopilotSkillDocs;
}

const defaultAdapters: CopilotExecutionAdapters = {
  runAgentTaskFn: runAgentTask,
  streamTaskCollectingFn: streamTaskCollecting,
  buildExaMcpServerFn: buildExaMcpServer,
  resolveCopilotSkillDocsFn: resolveCopilotSkillDocs,
};

async function emitActivity(
  policy: CopilotExecutionPolicy,
  activity: CopilotExecutionActivity,
): Promise<void> {
  try {
    await policy.observe?.(activity);
  } catch (error) {
    console.error('[copilot-execution] activity observer failed', { kind: activity.kind, error });
  }
}

/**
 * Build the one Copilot execution owner. The factory exists for the real SDK/external test
 * adapters; the persistent worker receives only the small execute function.
 */
export function createCopilotExecutionOwner(
  overrides: Partial<CopilotExecutionAdapters> = {},
): ExecuteCopilotTurn {
  const adapters = { ...defaultAdapters, ...overrides };

  return async (db, turn, policy) => {
    const lifecycleAbortController = new AbortController();
    const cancellationSignals = [
      { signal: lifecycleAbortController.signal, requestedBy: 'system' as const },
      { signal: policy.cancellation.signal, requestedBy: 'user' as const },
    ];
    const validationSignal = AbortSignal.any([
      lifecycleAbortController.signal,
      policy.cancellation.signal,
    ]);
    const deadlineAt = policy.deadlineAt;
    const actorRef = selectActorRef(turn.input.triggered_by);
    const callerActor = { kind: 'agent' as const, ref: actorRef };
    const correctionResolution = resolveDeterministicCorrectionContract(
      turn.input.user_message,
      turn.input.correction_contract,
    );
    const input: CopilotRunInput =
      correctionResolution.kind === 'clarify'
        ? turn.input
        : { ...turn.input, correction_contract: correctionResolution.contract };
    const authoritativeReply =
      correctionResolution.kind === 'clarify'
        ? { reply: correctionResolution.reply, correction: 'clarify' as const }
        : undefined;

    const validationTaskContext = (
      callCtx: Parameters<Parameters<typeof validatePreparedLearningContent>[1]['runTaskFn']>[2],
    ) => ({
      ...callCtx,
      db,
      signal: validationSignal,
      lifecycleAbortController,
      parentTaskRunId: turn.taskRunId,
      ...(deadlineAt !== undefined ? { providerSessionDeadlineAt: deadlineAt } : {}),
    });
    const validationRunner: Parameters<typeof validatePreparedLearningContent>[1]['runTaskFn'] =
      async (kind, taskInput, callCtx) => {
        await policy.cancellation.probe();
        validationSignal.throwIfAborted();
        const ctx = validationTaskContext(callCtx);
        switch (kind) {
          case 'QuizVerifyTask':
            return adapters.runAgentTaskFn('QuizVerifyTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validatePreparedLearningContent>[1]['runTaskFn']
            >;
          case 'SolutionGenerateTask':
            return adapters.runAgentTaskFn('SolutionGenerateTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validatePreparedLearningContent>[1]['runTaskFn']
            >;
          case 'SemanticJudgeTask':
            return adapters.runAgentTaskFn('SemanticJudgeTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validatePreparedLearningContent>[1]['runTaskFn']
            >;
          case 'TeachingQualityTask':
            return adapters.runAgentTaskFn('TeachingQualityTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validatePreparedLearningContent>[1]['runTaskFn']
            >;
          default:
            throw new Error(`unsupported learning-content validation task: ${kind}`);
        }
      };
    const validateLearningContent: ValidateLearningContentFn = (content) =>
      validatePreparedLearningContent(content, { db, runTaskFn: validationRunner });
    const finalizer = createCopilotReplyFinalizer({
      rootTaskRunId: turn.taskRunId,
      correctionContract: input.correction_contract,
      userContextText: [
        input.user_message,
        ...(input.validator_context_history ?? []).map((historyTurn) => historyTurn.text),
      ].join('\n'),
      ...(authoritativeReply ? { authoritativeReply } : {}),
      validateLearningContent: async (
        text,
        contextText,
        validationTaskRunId,
        primaryView,
        observedQuestion,
        remoteEvidence,
      ) => {
        await policy.cancellation.probe();
        validationSignal.throwIfAborted();
        return reviewCopilotLearningContent(text, contextText, validationTaskRunId, {
          db,
          runTaskFn: validationRunner,
          additionalVisibleText: primaryViewLearningContent(primaryView),
          additionalQuestionContent: primaryViewLearningQuestions(primaryView),
          observedQuestion,
          ...(remoteEvidence ? { remoteToolEvidence: remoteEvidence } : {}),
        });
      },
      resolveArtifactReference: (ref) => resolveLivePrimaryViewArtifact(db, ref),
    });

    const surface = input.surface;
    const baseContextBudget = resolveContextBudget(surface);
    const budgetTracker = new ContextBudgetTracker(baseContextBudget);
    const proposalFlowGate = createCopilotProposalFlowGate();
    // One mount-options literal feeds the pi AgentTool bridge
    // (`ctx.piToolMounts` → piDomainMount); the loop's native toolCall.id
    // supplies correlation via `correlatedToolUseId` (see pi-tools.ts).
    const domainMountOptions = {
      ctx: {
        db,
        sessionId: turn.sessionId,
        taskRunId: turn.taskRunId,
        providerAttemptCaller: 'worker',
        signal: lifecycleAbortController.signal,
        ...(deadlineAt !== undefined ? { providerSessionDeadlineAt: deadlineAt } : {}),
        callerActor,
        ...(turn.sourceEventId ? { causedByEventId: turn.sourceEventId } : {}),
        validateLearningContent,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames: resolveDomainToolNames(surface),
      taskKind: 'CopilotTask',
      cancellationSignals,
      beforeExecute: async (tool) =>
        (await policy.cancellation.beforeTool()) ??
        finalizer.beforeDomainTool(tool) ??
        proposalFlowGate.beforeExecute(tool) ??
        budgetTracker.beforeExecute(tool),
      onExecuteStart: (tool) => policy.cancellation.onToolExecutionStarted(tool),
      onExecuteSettled: () => policy.cancellation.onToolExecutionSettled(),
      interceptInput: (tool, args) => {
        const { args: capped, contextBudget, softStop } = budgetTracker.capInput(tool.name, args);
        return { args: capped, truncationNote: contextBudget, softStop };
      },
      onResult: (result) => {
        proposalFlowGate.observe(result);
        finalizer.observeDomainTool(result);
      },
      onToolComplete: (result) => {
        void Promise.resolve(emitActivity(policy, { kind: 'tool_finished', ...result })).catch(
          () => undefined,
        );
      },
    } satisfies BuildMcpServerOptions;
    const exa = adapters.buildExaMcpServerFn();
    const piToolMounts = [
      piDomainMount(domainMountOptions),
      ...(exa ? [piRemoteMcpMount(EXA_MCP_SERVER_NAME, exa, EXA_SCOPED_TOOL_NAMES)] : []),
    ];
    const baseAllowedTools = [
      ...resolveMcpAllowedTools(surface),
      ...(exa ? EXA_MCP_ALLOWED_TOOLS : []),
    ];
    const subagentsEnabled = policy.subagentsEnabled ?? isCopilotSubagentEnabled();
    // Root turns are uncapped; the nested researcher inherits that (its loop
    // still ends with the parent's abort lineage / owner deadline).
    const parentMaxTurns = undefined;
    const { allowedTools, piSpawnContract } = buildCopilotNativeResearchConfig({
      baseAllowedTools,
      enabled: subagentsEnabled,
      parentMaxTurns,
      onBudgetObservation: (observation) => {
        void Promise.resolve(emitActivity(policy, { kind: 'spawn_budget', observation })).catch(
          () => undefined,
        );
      },
    });
    const subtaskProjector = piSpawnContract ? createCopilotSubtaskProjector() : undefined;
    let nativeTaskEventsClosed = false;
    const openNativeTasks = new Set<string>();
    let nativeProjectionFailed = false;
    let nativeTaskEvents = Promise.resolve();
    const onTaskEvent = piSpawnContract
      ? (message: CopilotTaskLifecycleMessage) => {
          if (nativeTaskEventsClosed) return Promise.resolve();
          const projectedEvent = nativeTaskEvents.then(async () => {
            const projected = subtaskProjector?.(message);
            if (projected) await emitActivity(policy, { kind: 'subtask', event: projected });
            // Visibility is not lifecycle ownership: hidden terminal messages still
            // settle an admitted child; the persistence owner checks its identity.
            if (turn.sourceEventId) {
              const record = await handleNativeSubagentTaskEvent(db, message, {
                sessionId: turn.sessionId,
                parentTurnEventId: turn.sourceEventId,
                parentTaskRunId: turn.taskRunId,
              }).catch((error) => {
                nativeProjectionFailed = true;
                console.error('[copilot-execution] native subagent projection failed', {
                  session_id: turn.sessionId,
                  parent_task_run_id: turn.taskRunId,
                  error,
                });
              });
              if (record?.status === 'running') openNativeTasks.add(record.id);
              else if (record) openNativeTasks.delete(record.id);
            }
          });
          nativeTaskEvents = projectedEvent.catch(() => undefined);
          return projectedEvent;
        }
      : undefined;

    // Remote-MCP completion card: `onToolComplete` lives inside the domain
    // bridge (executeDomainToolCall), so remote calls never produced a
    // tool_finished step — the SSE card spun forever. The pi afterToolCall
    // observer fires for every settled call including remote ones; emit the
    // matching finish here. Domain tools are excluded (their card already
    // comes from the bridge); native Task/Agent calls never match the
    // `mcp__` predicate.
    const remoteMcpToolFinished: PiAfterToolCall = (observation) => {
      if (!isRemoteMcpToolCall(observation.call.name)) return undefined;
      const summaryText = observation.isError
        ? `error: ${piToolErrorText(observation.error)}`
        : piToolErrorText(observation.output);
      void Promise.resolve(
        emitActivity(policy, {
          kind: 'tool_finished',
          toolName: observation.call.name,
          input: observation.args,
          summary: summaryText.slice(0, 180),
          ...(observation.isError
            ? { errorReason: piToolErrorText(observation.error).slice(0, 500) }
            : {}),
          toolUseId: observation.call.id,
        }),
      ).catch(() => undefined);
      return undefined;
    };

    // The hook stack: finalizer entries first, then cancellation, spawn gate
    // last — the spawn gate's `{block:false}` allow short-circuit requires it
    // to run after every deny-capable entry. The loop's native toolCall.id
    // reaches the pipeline verbatim (no correlation hook needed).
    const piHooks = prependCopilotPiFinalizationHooks(finalizer.piHooks, {
      beforeToolCall: [
        policy.cancellation.piBeforeToolCall,
        ...(piSpawnContract ? [piSpawnContract.gate] : []),
      ],
      afterToolCall: [remoteMcpToolFinished],
    });
    const piSkillDocs = await adapters.resolveCopilotSkillDocsFn();
    const contextDigest = copilotSessionContextDigest(input);
    const resumeSessionId = policy.resumeSessionId;
    const mode: 'cold' | 'resume' = resumeSessionId ? 'resume' : 'cold';
    const compiledModelPrompt = {
      text: compileCopilotModelInput(input, mode, {
        includeProposalFeedback:
          !resumeSessionId || shouldDeliverCopilotSessionContext(resumeSessionId, contextDigest),
      }),
      codecVersion: COPILOT_TURN_CONTEXT_CODEC_VERSION,
      mode,
      contextDigest,
    };
    let observedSdkSessionId: string | undefined;
    const sdkSession = {
      persist: true as const,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      onSessionId: (sessionId: string) => {
        observedSdkSessionId = sessionId;
      },
    };
    const runnerContext: Parameters<typeof streamTaskCollecting>[2] = {
      db,
      taskRunId: turn.taskRunId,
      signal: policy.cancellation.signal,
      lifecycleAbortController,
      compiledModelPrompt,
      allowedTools: authoritativeReply ? [] : allowedTools,
      ...(piSpawnContract ? { onTaskEvent } : {}),
      // An explicit empty allowlist (authoritativeReply) must not connect
      // remote mounts — piRemoteMcpMount talks to Exa at buildTools time and
      // an outage would fail an intentionally tool-less turn.
      piToolMounts: authoritativeReply ? [] : piToolMounts,
      piHooks,
      ...(piSpawnContract ? { piAgents: piSpawnContract.piAgents } : {}),
      ...(piSkillDocs ? { piSkillDocs } : {}),
      // Resume on pi = replay the bounded durable turns into context.messages
      // (the provider-session-file equivalent). Only when resuming — a cold
      // prompt already folds conversation_history into its envelope, and
      // seeding it again would double the history.
      ...(resumeSessionId
        ? {
            piSessionReplay: input.conversation_history.map((turn) => ({
              role: turn.role === 'ai' ? ('assistant' as const) : turn.role,
              text: turn.text,
            })),
          }
        : {}),
      ...(policy.modelBinding ? { modelBinding: policy.modelBinding } : {}),
      budgetOverride: {
        maxIterations: 'unbounded',
        timeoutMs: DURABLE_COPILOT_EXECUTION_BUDGET.timeoutMs,
      },
      sdkSession,
      nativeCompaction: { sessionContext: compileCopilotSessionContext(input) },
      onToolUse: (call) => {
        if (!shouldEmitToolUseForCaller(call.toolName, DOMAIN_TOOL_MCP_SERVER_NAME, callerActor)) {
          return;
        }
        void Promise.resolve(emitActivity(policy, { kind: 'tool_started', ...call })).catch(
          () => undefined,
        );
      },
    };
    let candidateDeltaObserved = false;
    let retainSdkSession = false;
    const disposeSubagentCancellation = bindSubagentParentCancellation(db, {
      sessionId: turn.sessionId,
      parentTaskRunId: turn.taskRunId,
      signals: cancellationSignals,
    });
    let nativeDrain: Promise<boolean> | undefined;
    const drainNativeTasks = () => {
      nativeDrain ??= (async () => {
        nativeTaskEventsClosed = true;
        await nativeTaskEvents;
        await disposeSubagentCancellation();
        // Engine exit is not the product outcome: Stop can still win during
        // finalization or the worker's commit. Only the durable owner may
        // settle missing child results, after its outcome has committed.
        return openNativeTasks.size === 0 && !nativeProjectionFailed;
      })().catch((error) => {
        // Preserve the paid root outcome; durable parent reconciliation can
        // retry the projection without buying another model execution.
        console.error('[copilot-execution] native lifecycle drain failed', {
          session_id: turn.sessionId,
          parent_task_run_id: turn.taskRunId,
          error,
        });
        return false;
      });
      return nativeDrain;
    };

    try {
      const result = await adapters.streamTaskCollectingFn(
        'CopilotTask',
        input,
        runnerContext,
        (text) => {
          if (text.length > 0) candidateDeltaObserved = true;
        },
      );
      // Partial results carry the collected assistant text in `text` but no
      // `terminalText` (set only on a clean success frame) — fall back so the
      // finalizer reviews whatever was actually produced instead of ''.
      const terminalText = result.terminalText ?? result.text;
      const nativeChildrenComplete = await drainNativeTasks();
      const partial = result.partial === true;
      const executionError = result.error;
      const finalization = await finalizer.finalizeTerminal(terminalText);
      retainSdkSession = !partial && finalization.accepted && nativeChildrenComplete;
      return {
        taskRunId: result.task_run_id,
        finishReason: result.finishReason ?? 'unknown',
        finalization,
        partial,
        ...(executionError ? { error: executionError } : {}),
        candidateDeltaObserved,
        ...(observedSdkSessionId && retainSdkSession ? { sdkSessionId: observedSdkSessionId } : {}),
        contextDigest,
      };
    } finally {
      await drainNativeTasks();
      if (!retainSdkSession) {
        if (observedSdkSessionId) clearCopilotWorkerSession(turn.sessionId, observedSdkSessionId);
        if (resumeSessionId) clearCopilotWorkerSession(turn.sessionId, resumeSessionId);
      }
    }
  };
}

export const executeCopilotTurn: ExecuteCopilotTurn = createCopilotExecutionOwner();
