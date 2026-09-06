import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Db } from '@/db/client';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/kernel/tools/allowlists';
import { resolveContextBudget } from '@/kernel/tools/budgets';
import { ContextBudgetTracker } from '@/kernel/tools/context-throttle';
import type { ValidateLearningContentFn } from '@/kernel/tools/types';
import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  buildTavilyMcpServer,
} from '@/server/ai/mcp/tavily';
import {
  type RunTaskResult,
  type StreamCollectResult,
  runAgentTask,
  streamTaskCollecting,
} from '@/server/ai/runner';
import {
  type BuildMcpServerOptions,
  type SdkMcpServer,
  buildMcpServerFromRegistry,
  createToolUseCorrelation,
  shouldEmitToolUseForCaller,
} from '@/server/ai/tools/mcp-bridge';
import { resolveCopilotSkills } from '@/subjects/copilot-skills';
import { copilotTaskSpec } from '../tasks/agent';
import { reviewCopilotLearningContent, validateCopilotLearningContent } from './content-validation';
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
import { resolveLivePrimaryViewArtifact } from './primary-view-reference';
import { createCopilotProposalFlowGate } from './proposal-flow-gate';
import {
  type CopilotReplyFinalizationResult,
  createCopilotReplyFinalizer,
  prependCopilotFinalizationHooks,
  primaryViewLearningContent,
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

/** Persistence removes the HTTP deadline, not the existing default model/tool cost caps. */
export const DURABLE_COPILOT_EXECUTION_BUDGET = {
  maxIterations: copilotTaskSpec.definition.budget.maxIterations,
  maxToolCalls: resolveContextBudget('copilot').toolCalls.hard,
  timeoutMs: 12 * 60_000,
} as const;

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

/** Process-level adapters. Product callers use ExecuteCopilotTurn, never this SDK-shaped seam. */
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
  buildMcpServerFn: (options: BuildMcpServerOptions) => SdkMcpServer;
  buildTavilyMcpServerFn: () => McpHttpServerConfig | null;
  resolveCopilotSkillsFn: typeof resolveCopilotSkills;
}

const defaultAdapters: CopilotExecutionAdapters = {
  runAgentTaskFn: runAgentTask,
  streamTaskCollectingFn: streamTaskCollecting,
  buildMcpServerFn: buildMcpServerFromRegistry,
  buildTavilyMcpServerFn: buildTavilyMcpServer,
  resolveCopilotSkillsFn: resolveCopilotSkills,
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
      callCtx: Parameters<Parameters<typeof validateCopilotLearningContent>[1]['runTaskFn']>[2],
    ) => ({
      ...callCtx,
      db,
      signal: validationSignal,
      lifecycleAbortController,
      parentTaskRunId: turn.taskRunId,
      ...(deadlineAt !== undefined ? { providerSessionDeadlineAt: deadlineAt } : {}),
    });
    const validationRunner: Parameters<typeof validateCopilotLearningContent>[1]['runTaskFn'] =
      async (kind, taskInput, callCtx) => {
        await policy.cancellation.probe();
        validationSignal.throwIfAborted();
        const ctx = validationTaskContext(callCtx);
        switch (kind) {
          case 'QuizVerifyTask':
            return adapters.runAgentTaskFn('QuizVerifyTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validateCopilotLearningContent>[1]['runTaskFn']
            >;
          case 'SolutionGenerateTask':
            return adapters.runAgentTaskFn('SolutionGenerateTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validateCopilotLearningContent>[1]['runTaskFn']
            >;
          case 'SemanticJudgeTask':
            return adapters.runAgentTaskFn('SemanticJudgeTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validateCopilotLearningContent>[1]['runTaskFn']
            >;
          case 'TeachingQualityTask':
            return adapters.runAgentTaskFn('TeachingQualityTask', taskInput, ctx) as ReturnType<
              Parameters<typeof validateCopilotLearningContent>[1]['runTaskFn']
            >;
          default:
            throw new Error(`unsupported learning-content validation task: ${kind}`);
        }
      };
    const validateLearningContent: ValidateLearningContentFn = (content) =>
      validateCopilotLearningContent(content, { db, runTaskFn: validationRunner });
    const finalizer = createCopilotReplyFinalizer({
      rootTaskRunId: turn.taskRunId,
      correctionContract: input.correction_contract,
      userContextText: [
        input.user_message,
        ...(input.validator_context_history ?? []).map((historyTurn) => historyTurn.text),
      ].join('\n'),
      ...(authoritativeReply ? { authoritativeReply } : {}),
      validateLearningContent: async (text, contextText, validationTaskRunId, primaryView) => {
        await policy.cancellation.probe();
        validationSignal.throwIfAborted();
        return reviewCopilotLearningContent(text, contextText, validationTaskRunId, {
          db,
          runTaskFn: validationRunner,
          additionalVisibleText: primaryViewLearningContent(primaryView),
        });
      },
      resolveArtifactReference: (ref) => resolveLivePrimaryViewArtifact(db, ref),
    });

    const surface = input.surface;
    const baseContextBudget = resolveContextBudget(surface);
    const budgetTracker = new ContextBudgetTracker(baseContextBudget);
    const proposalFlowGate = createCopilotProposalFlowGate();
    const toolUseCorrelation = createToolUseCorrelation(DOMAIN_TOOL_MCP_SERVER_NAME);
    const mcpServer = adapters.buildMcpServerFn({
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
      claimToolUseId: toolUseCorrelation.claim,
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
    });
    const tavily = adapters.buildTavilyMcpServerFn();
    const mcpServers: Record<string, SdkMcpServer | McpHttpServerConfig> = {
      [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer,
      ...(tavily ? { [TAVILY_MCP_SERVER_NAME]: tavily } : {}),
    };
    const baseAllowedTools = [
      ...resolveMcpAllowedTools(surface),
      ...(tavily ? TAVILY_MCP_ALLOWED_TOOLS : []),
    ];
    const subagentsEnabled = policy.subagentsEnabled ?? isCopilotSubagentEnabled();
    const parentMaxTurns = DURABLE_COPILOT_EXECUTION_BUDGET.maxIterations;
    const { allowedTools, spawnContract } = buildCopilotNativeResearchConfig({
      baseAllowedTools,
      enabled: subagentsEnabled,
      parentMaxTurns,
      onBudgetObservation: (observation) => {
        void Promise.resolve(emitActivity(policy, { kind: 'spawn_budget', observation })).catch(
          () => undefined,
        );
      },
    });
    const subtaskProjector = spawnContract ? createCopilotSubtaskProjector() : undefined;
    const onTaskEvent = spawnContract
      ? async (message: CopilotTaskLifecycleMessage) => {
          const projected = subtaskProjector?.(message);
          if (projected) await emitActivity(policy, { kind: 'subtask', event: projected });
          // Visibility is not lifecycle ownership: hidden terminal messages still
          // settle an admitted child; the persistence owner checks its identity.
          if (turn.sourceEventId) {
            await handleNativeSubagentTaskEvent(db, message, {
              sessionId: turn.sessionId,
              parentTurnEventId: turn.sourceEventId,
              parentTaskRunId: turn.taskRunId,
            }).catch((error) => {
              console.error('[copilot-execution] native subagent projection failed', {
                session_id: turn.sessionId,
                parent_task_run_id: turn.taskRunId,
                error,
              });
            });
          }
        }
      : undefined;

    let sdkHooks = toolUseCorrelation.prepend(
      policy.cancellation.prependSdkHook(spawnContract?.hooks),
    );
    sdkHooks = prependCopilotFinalizationHooks(finalizer.hooks, sdkHooks);
    const skills = await adapters.resolveCopilotSkillsFn();
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
      mcpServers,
      allowedTools: authoritativeReply ? [] : allowedTools,
      hooks: sdkHooks,
      ...(spawnContract
        ? {
            agents: spawnContract.agents,
            canUseTool: spawnContract.canUseTool,
            onTaskEvent,
          }
        : {}),
      ...(skills ? { skills } : {}),
      budgetOverride: {
        maxIterations: DURABLE_COPILOT_EXECUTION_BUDGET.maxIterations,
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

    try {
      const result = await adapters.streamTaskCollectingFn(
        'CopilotTask',
        input,
        runnerContext,
        (text) => {
          if (text.length > 0) candidateDeltaObserved = true;
        },
      );
      const terminalText = result.terminalText ?? '';
      const partial = result.partial === true;
      const executionError = result.error;
      if (resumeSessionId && partial) {
        throw new Error('resumed Agent SDK session returned partial output');
      }
      const finalization = await finalizer.finalizeTerminal(terminalText);
      retainSdkSession = !partial && finalization.accepted;
      return {
        taskRunId: result.task_run_id,
        finishReason: result.finishReason ?? 'unknown',
        finalization,
        partial,
        ...(executionError ? { error: executionError } : {}),
        candidateDeltaObserved,
        ...(observedSdkSessionId ? { sdkSessionId: observedSdkSessionId } : {}),
        contextDigest,
      };
    } finally {
      if (!retainSdkSession) {
        if (observedSdkSessionId) clearCopilotWorkerSession(turn.sessionId, observedSdkSessionId);
        if (resumeSessionId) clearCopilotWorkerSession(turn.sessionId, resumeSessionId);
      }
      await disposeSubagentCancellation();
    }
  };
}

export const executeCopilotTurn: ExecuteCopilotTurn = createCopilotExecutionOwner();
