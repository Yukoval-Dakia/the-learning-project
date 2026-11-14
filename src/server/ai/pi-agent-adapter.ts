// YUK-921 P4 — the only execution adapter. One agentLoop per query. Frame and
// prompt normalization lives in pi-runner-frames.ts so the consume loop keeps
// one lifecycle implementation.
//
// Contract retained from the SDK lane: identical `mcp__<server>__<tool>` wire
// names; maxTurns maps to finishTurn ('error_max_turns'); abort emits no
// terminal frame so the lifecycle's `aborted` flag stays the cancellation
// truth; every opencode request carries `x-opencode-session` with the durable
// run id (the per-attempt fencing identity).
//
// `ctx.piQueues` (steering/follow-up) is wired but has no live consumer yet.

import { randomUUID } from 'node:crypto';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  FinishTurn,
  StreamFn,
  agentLoop as piAgentLoop,
} from '@earendil-works/pi-agent-core';
import type {
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  Model as PiModel,
  MutableModels as PiMutableModels,
} from '@earendil-works/pi-ai';
import { helpFaultForRootStatus, rootBoundProviderStatus } from '@/ai/help-provider-fault';
import { NO_PROGRESS_BUDGET_LANDING_MARGIN_MS } from '@/ai/no-progress-loop';
import { type PiToolMount, piCustomTool, piToolWireName } from '@/ai/pi-tool-mount';
import { providerQuotaLimitSigned, providerRequestInterruption } from '@/ai/provider-failure';
import { type TaskDefinition, resolveStructuredSubmitSchema } from '@/ai/task-spec';
import { tasks } from '@/capabilities/task-registry';
import { customProviderDefinitions } from '@/core/config/custom-providers';
import { getConfig } from '@/core/config/store';
import { rawArgumentsEvidence } from '@/core/raw-arguments-evidence';
import { type PiSubagentSpec, isSpawnToolName } from '@/core/subagent-contract';
import {
  AGENT_WORKSPACE_DOMAIN_TOOLS,
  DOMAIN_TOOL_MCP_SERVER_NAME,
} from '@/kernel/tools/allowlists';
import type {
  ExecutionAdapter,
  ExecutionAdapterStartupArgs,
  PreparedExecutionQuery,
  RunnerMessage,
} from './execution-adapter';
import { traceOperation } from './laminar-tracing';
import { createPiContextCompactionPolicy, estimatePiTokens } from './pi-context-policy';
import { MAX_BUDGET_STOP_REASON, createPiCostCeiling } from './pi-cost-ceiling';
import { emitPiAfterToolCall, runPiBeforeToolCall } from './pi-hooks';
import { completedChildReport, installLoopProgress, turnLimiter } from './pi-loop-progress';
import { type LoomPiModel, createLoomPiModels } from './pi-models';
import { piProviderId } from './pi-provider-catalog';
import { PiProviderWire } from './pi-provider-wire';
import { requestRetryMarkers, retryInterruptedRequest } from './pi-request-retry';
import {
  type PiToolResultMessage,
  collectPromptMessages,
  emptyPiChildUsage,
  lastAssistantMessage,
  piAssistantToSdkFrame,
  piCompactBoundaryFrame,
  piInitFrame,
  piReplayTurnsToMessages,
  piTaskProgressFrame,
  piTaskStartedFrame,
  piTaskUpdatedFrame,
  piTerminalResultFrame,
  piToolResultToSdkFrame,
  piUserMessage,
} from './pi-runner-frames';
import { composePiSystemPrompt } from './pi-system-prompt';
import { PiToolSurface } from './pi-tool-surface';
import { hasPiUsageEvidence } from './pi-usage-evidence';
import { sanitizeArgumentsEvidenceText } from './provider-error-evidence';
import { interruptedRequestRetryBound } from './provider-transient-retry';
import { TaskConfigError } from './providers';
import type { SDKUserMessage } from './sdk-types';
import {
  STRUCTURED_OUTPUT_SUBMIT_TOOL,
  createStructuredSubmitLoop,
  structuredSubmitSystemSuffix,
  structuredSubmitUnitSuffix,
} from './structured-submit';
import { isToolParamContractRejection } from './tool-param-contract';
import { type PiSubagentHost, buildPiSpawnAgentTools } from './tools/pi-subagent';
import {
  type PiRemoteMcpMountHandle,
  buildPiDomainAgentTools,
  connectPiRemoteMcp,
  connectTaskRemoteMcp,
} from './tools/pi-tools';

type PiModels = Pick<PiMutableModels, 'getModel' | 'streamSimple'>;

/** Injectable seams so unit tests can pin behavior without network or mocks. */
export interface PiAdapterDeps {
  models?: PiModels;
  agentLoop?: typeof piAgentLoop;
  /** Test seam for the remote-MCP bridge — production resolves the real client. */
  connectRemoteMcp?: typeof connectPiRemoteMcp;
}

const STRUCTURED_OUTPUT_TOOL = STRUCTURED_OUTPUT_SUBMIT_TOOL;

function toolOutputSchema(kind: ExecutionAdapterStartupArgs['kind'], input?: unknown) {
  return resolveStructuredSubmitSchema(tasks[kind], input);
}

/**
 * YUK-590 — provider retry cap, preserving the CLAUDE_CODE_MAX_RETRIES env
 * contract. Default 2 leaves short transients to the provider client and returns control to
 * loom's one deliberate retry layer.
 */
export function piMaxRetries(): number | undefined {
  // YUK-1007: DB > env > code default.
  const v = getConfig('CLAUDE_CODE_MAX_RETRIES');
  return typeof v === 'number' ? v : 2;
}

/**
 * `pi:`-prefixed session ids keep a persisted `agent_sdk_session_id` cursor
 * unambiguous. A cross-process attempt cold-starts from durable-turn replay.
 */
export const PI_SESSION_ID_PREFIX = 'pi:';

function piSessionIdFor(optionsResume: string | undefined): string {
  return optionsResume?.startsWith(PI_SESSION_ID_PREFIX)
    ? optionsResume
    : `${PI_SESSION_ID_PREFIX}${randomUUID()}`;
}

/**
 * Prepared pi query: `query()` runs ONE agentLoop and yields normalized frames;
 * `close()` aborts it. Frames produced inside the loop (subagent task_*,
 * compact_boundary) go through `queuedFrames` so wire ordering matches the SDK.
 */
class PiPreparedQuery implements PreparedExecutionQuery {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly externalSignal: AbortSignal | undefined;
  private readonly sessionId: string;
  private readonly toolSurface: PiToolSurface;
  private readonly wire: PiProviderWire;
  private readonly queuedFrames: RunnerMessage[] = [];
  private readonly childUsage = emptyPiChildUsage();
  /**
   * YUK-1547 (C1) — ONE run-scoped parameter-contract correction allowance,
   * shared by the root loop and every nested child loop: a second rejection
   * ends the loop regardless of the iteration ceiling. The structured-submit
   * lane uses its own progress closure instead.
   */
  private paramContractCorrectionUsed = false;

  constructor(
    private readonly args: ExecutionAdapterStartupArgs,
    private readonly model: LoomPiModel,
    private readonly deps: Required<PiAdapterDeps>,
    tools: AgentTool[],
    private readonly remoteMcpHandles: PiRemoteMcpMountHandle[],
  ) {
    this.externalSignal = args.options.abortController?.signal;
    if (this.externalSignal?.aborted) {
      this.abort.abort();
    } else {
      this.externalSignal?.addEventListener('abort', () => this.abort.abort(), { once: true });
    }
    this.sessionId = piSessionIdFor(
      typeof args.options.resume === 'string' ? args.options.resume : undefined,
    );
    // Spawn tools live here (not in buildTools) because the host binds to this
    // query's frame sink and abort lineage. `Task` honors the same allowedTools
    // filter as the domain mounts.
    const allowed = Array.isArray(args.options.tools)
      ? new Set(args.options.tools as string[])
      : undefined;
    const spawnTools =
      args.piAgents && Object.keys(args.piAgents).length > 0
        ? buildPiSpawnAgentTools(args.piAgents, this.subagentHost)
        : [];
    const visibleSpawn =
      allowed === undefined ? spawnTools : spawnTools.filter((tool) => allowed.has(tool.name));
    this.toolSurface = new PiToolSurface({
      tools: [...tools, ...visibleSpawn],
      sessionId: this.sessionId,
      runId: args.runId,
      secrets:
        args.resolved.authMode !== 'oauth-file' && args.resolved.apiKey
          ? [args.resolved.apiKey]
          : [],
      emitFrame: (frame) => this.emitFrame(frame),
    });
    this.wire = new PiProviderWire({
      kind: args.kind,
      runId: args.runId,
      resolved: args.resolved,
      options: args.options,
      streamSimple: (m, context, options) => this.deps.models.streamSimple(m, context, options),
      wireParameters: this.toolSurface.wireParameters(),
      structuredOutput: toolOutputSchema(args.kind) !== undefined,
      readMaxRetries: () => piMaxRetries(),
    });
  }

  private emitFrame(frame: RunnerMessage): void {
    this.queuedFrames.push(frame);
  }

  /** Drain frames produced inside the loop (subagent lifecycle, compaction). */
  private *drainFrames(): Generator<RunnerMessage> {
    while (this.queuedFrames.length > 0) {
      const frame = this.queuedFrames.shift();
      if (frame !== undefined) yield frame;
    }
  }

  query(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<RunnerMessage> {
    if (this.closed) {
      throw new Error('pi prepared query closed before prompt submission');
    }
    return this.iterate(collectPromptMessages(prompt));
  }

  /**
   * Composed beforeToolCall gate for one loop level: caller-declared piHooks
   * gates run in declaration order with first-defined-result short-circuit.
   * `agentType` marks nested calls.
   */
  private makeBeforeToolCall(agentType?: string): AgentLoopConfig['beforeToolCall'] {
    const piHooks = this.args.piHooks;
    return async ({ toolCall, args: callArgs }: BeforeToolCallContext, signal) => {
      this.wire.throwIfFailed();
      if (!piHooks?.beforeToolCall?.length) return undefined;
      const effectiveSignal = signal ?? this.abort.signal;
      return runPiBeforeToolCall(
        piHooks,
        { id: toolCall.id, name: toolCall.name, ...(agentType ? { agentType } : {}) },
        (callArgs ?? {}) as Record<string, unknown>,
        effectiveSignal,
      );
    };
  }

  /**
   * pi `afterToolCall` config (PostToolUse/PostToolUseFailure). Observers fire in
   * declaration order; the bridge's merged override is what the model sees.
   */
  private makeAfterToolCall(agentType?: string): AgentLoopConfig['afterToolCall'] {
    const piHooks = this.args.piHooks;
    if (!piHooks?.afterToolCall?.length) return undefined;
    return async ({ toolCall, args: callArgs, result, isError }, signal) => {
      const effectiveSignal = signal ?? this.abort.signal;
      return emitPiAfterToolCall(
        piHooks,
        {
          call: { id: toolCall.id, name: toolCall.name, ...(agentType ? { agentType } : {}) },
          args: (callArgs ?? {}) as Record<string, unknown>,
          isError,
          output: result.content,
          ...(isError ? { error: result.content } : {}),
          // SDK PostToolUseFailure carries is_interrupt — the abort lineage
          // being live at settle time is the pi equivalent.
          ...(effectiveSignal.aborted ? { interrupted: true } : {}),
        },
        effectiveSignal,
      );
    };
  }

  /**
   * ADR-0060 compaction on the pi lane: `transformContext` prunes to the target
   * window, re-injects the bounded sessionContext, and emits a compact_boundary
   * frame so `sdk-terminal`'s usage evidence stays identical. Never throws — on
   * failure the original messages pass through.
   */
  private makeTransformContext(): AgentLoopConfig['transformContext'] {
    const compaction = this.args.nativeCompaction;
    if (!compaction) return undefined;
    const sessionId = this.sessionId;
    const sessionContext = compaction.sessionContext;
    const planCompaction = createPiContextCompactionPolicy(this.model, sessionContext);

    return async (messages) => {
      try {
        const plan = planCompaction(messages);
        if (!plan) return messages;
        const startedAt = Date.now();
        // Keep the newest tail that fits the target; the current-turn prompt is
        // last and never dropped. Pi 1.0 carries instructions and tool
        // declarations in system messages, so replay their deltas before pruning.
        const { getCurrentSystemMessage } = await import('@earendil-works/pi-ai');
        const system = getCurrentSystemMessage(messages);
        const transformed = plan.selectMessages(system, piUserMessage);
        this.emitFrame(
          piCompactBoundaryFrame({
            sessionId,
            preTokens: plan.preTokens,
            postTokens: estimatePiTokens(transformed),
            durationMs: Date.now() - startedAt,
          }),
        );
        return transformed;
      } catch (error) {
        console.warn('[pi-adapter] transformContext failed; passing context through', {
          error: error instanceof Error ? error.message : String(error),
        });
        return messages;
      }
    };
  }

  /**
   * YUK-1547 (C1) — the run-scoped parameter-contract correction gate for every
   * loop level: a rejection may continue ONCE so the model can re-issue the
   * call; a second one ends the loop regardless of the turn ceiling. Clean turns
   * defer to `inner`.
   */
  private contractCorrectionFinishTurn(inner?: FinishTurn): FinishTurn {
    return (turn, signal) => {
      if (turn.toolResults.some((result) => isToolParamContractRejection(result))) {
        if (this.paramContractCorrectionUsed) return { action: 'end' as const };
        this.paramContractCorrectionUsed = true;
      }
      return inner?.(turn, signal);
    };
  }

  /**
   * Child tool set: the spec's allowlist over mounted wire names, minus
   * disallowedTools, minus spawn aliases (depth-one is structural).
   * Workspace tools granted to a child are rebuilt against a per-spawn owner
   * scope so the child gets its own directory — never the parent's files.
   */
  private childToolsFor(spec: PiSubagentSpec, toolCallId: string): AgentTool[] {
    const parentTools = this.toolSurface.tools.filter((tool) => !isSpawnToolName(tool.name));
    const allowlisted =
      spec.tools === undefined
        ? parentTools
        : parentTools.filter((tool) => spec.tools?.includes(tool.name));
    const disallowed = new Set(spec.disallowedTools ?? []);
    const visible = allowlisted.filter((tool) => !disallowed.has(tool.name));
    const workspaceWires = new Set(
      AGENT_WORKSPACE_DOMAIN_TOOLS.map((name) => piToolWireName(DOMAIN_TOOL_MCP_SERVER_NAME, name)),
    );
    const scopedNames = new Set(
      visible.filter((t) => workspaceWires.has(t.name)).map((t) => t.name),
    );
    if (scopedNames.size === 0) return visible;
    const rebuilt: AgentTool[] = [];
    const done = new Set<string>();
    for (const mount of this.args.piToolMounts ?? []) {
      if (mount.type !== 'domain') continue;
      for (const toolName of mount.options.toolNames) {
        const wire = piToolWireName(mount.options.serverName, toolName);
        if (!scopedNames.has(wire) || done.has(wire)) continue;
        done.add(wire);
        rebuilt.push(
          ...buildPiDomainAgentTools({
            ...mount.options,
            toolNames: [toolName],
            ctx: { ...mount.options.ctx, workspaceOwnerId: `agent:${toolCallId}` },
            logTaskRunId: this.args.runId,
          }),
        );
      }
    }
    return [...visible.filter((t) => !scopedNames.has(t.name)), ...rebuilt];
  }

  /**
   * A resent request's dead attempt never reaches the transcript, so its spend
   * rides the out-of-transcript accumulator. A stalled stream rarely carries a
   * usage frame; then the sent context and the partial output are estimated
   * at the model's catalog price rather than recorded as free.
   */
  private chargeDeadRequest(dead: PiAssistantMessage, sent: readonly AgentMessage[]): void {
    const reported = hasPiUsageEvidence(dead);
    const input = reported ? dead.usage.input : estimatePiTokens(sent);
    const output = reported ? dead.usage.output : estimatePiTokens([dead]);
    const costUsd = reported
      ? dead.usage.cost.total
      : (input * this.model.cost.input + output * this.model.cost.output) / 1_000_000;
    this.childUsage.input += input;
    this.childUsage.output += output;
    this.childUsage.costUsd += costUsd;
    const entry = this.childUsage.byModel.get(this.model.id) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: this.model.contextWindow,
      maxOutputTokens: this.model.maxTokens,
    };
    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.costUSD += costUsd;
    this.childUsage.byModel.set(this.model.id, entry);
    console.warn('[pi] interrupted_request_resent', {
      run_id: this.args.runId,
      kind: this.args.kind,
      usage_basis: reported ? 'reported' : 'estimated',
      input_tokens: input,
      output_tokens: output,
      cost_usd: costUsd,
    });
  }

  /**
   * Nested-run host for Task/Agent: ONE child agentLoop under the parent's abort
   * lineage, emitting task_started/progress/updated frames for the durable
   * projection. Child failures throw → error tool result.
   */
  private readonly subagentHost: PiSubagentHost = {
    runNested: async ({ toolCallId, subagentType, description, prompt, spec, signal }) =>
      traceOperation(
        'agent.child',
        {
          task_run_id: this.args.runId,
          tool_call_id: toolCallId,
          additive_usage: false,
        },
        async () => {
          const taskId = toolCallId;
          const startedAt = Date.now();
          this.emitFrame(
            piTaskStartedFrame({
              sessionId: this.sessionId,
              taskId,
              toolCallId,
              description,
              subagentType,
              prompt,
            }),
          );
          const childModel = this.childModelFor(spec);
          const childTools = this.childToolsFor(spec, toolCallId);
          const childSignal = signal
            ? AbortSignal.any([this.abort.signal, signal])
            : this.abort.signal;
          const childContext: AgentContext = {
            messages: [{ role: 'system', content: spec.prompt, timestamp: Date.now() }],
            ...(childTools.length > 0 ? { tools: childTools } : {}),
          };
          const childMaxTurns = spec.maxTurns;
          let childCapped = false;
          let toolUses = 0;
          let totalTokens = 0;
          let lastToolName: string | undefined;
          const childConfig: AgentLoopConfig = {
            model: childModel,
            ...this.wire.loopConfig(),
            ...(childTools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
            finishTurn: this.contractCorrectionFinishTurn(
              childMaxTurns !== undefined
                ? turnLimiter(childMaxTurns, () => {
                    childCapped = true;
                  })
                : undefined,
            ),
            beforeToolCall: this.makeBeforeToolCall(subagentType),
            afterToolCall: this.makeAfterToolCall(subagentType),
          };

          const childProgress = installLoopProgress(childConfig, childTools, this.args.piHooks, {
            agentType: subagentType,
            loopId: taskId,
          });

          const accumulate = (message: PiAssistantMessage) => {
            const usage = message.usage;
            if (!usage) return;
            totalTokens += usage.totalTokens;
            this.childUsage.input += usage.input;
            this.childUsage.output += usage.output;
            this.childUsage.cacheRead += usage.cacheRead;
            this.childUsage.cacheWrite += usage.cacheWrite;
            this.childUsage.costUsd += usage.cost.total;
            const entry = this.childUsage.byModel.get(childModel.id) ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0,
              contextWindow: childModel.contextWindow,
              maxOutputTokens: childModel.maxTokens,
            };
            entry.inputTokens += usage.input;
            entry.outputTokens += usage.output;
            entry.cacheReadInputTokens += usage.cacheRead;
            entry.cacheCreationInputTokens += usage.cacheWrite;
            entry.costUSD += usage.cost.total;
            this.childUsage.byModel.set(childModel.id, entry);
          };

          let finalMessages: AgentMessage[] = [];
          const childRawArgs = new Map<number, string>();
          const childStreamedArgs = new Map<string, string>();
          try {
            const stream = this.deps.agentLoop(
              [piUserMessage(prompt)],
              childContext,
              childConfig,
              childSignal,
              this.wire.streamFn,
            );
            for await (const event of stream) {
              this.toolSurface.trackStreamedArgs(event, childRawArgs, childStreamedArgs);
              this.toolSurface.observeToolAttempt(
                event,
                childStreamedArgs,
                this.abort.signal.aborted,
              );
              if (event.type === 'tool_execution_start') {
                toolUses += 1;
                lastToolName = event.toolName;
                continue;
              }
              if (event.type === 'message_end' && event.message.role === 'assistant') {
                const assistant = event.message as PiAssistantMessage;
                accumulate(assistant);
                this.emitFrame(
                  piTaskProgressFrame({
                    sessionId: this.sessionId,
                    taskId,
                    toolCallId,
                    description,
                    subagentType,
                    totalTokens,
                    toolUses,
                    durationMs: Date.now() - startedAt,
                    ...(lastToolName ? { lastToolName } : {}),
                  }),
                );
                continue;
              }
              if (event.type === 'agent_end') {
                finalMessages = event.messages;
              }
            }
            if (childSignal.aborted || this.abort.signal.aborted) {
              throw new Error('nested subagent aborted');
            }
            const final = lastAssistantMessage(finalMessages);
            // Root-loop terminal parity: no assistant, a capped ceiling, or a
            // provider error means the child FAILED — a completed task_* row
            // would let the parent answer from a report that does not exist.
            if (!final) {
              throw new Error(
                `nested subagent '${subagentType}' ended without an assistant message`,
              );
            }
            if (childCapped) {
              throw new Error(
                `nested subagent '${subagentType}' stopped at the configured turn ceiling (${childMaxTurns})`,
              );
            }
            if (final.stopReason === 'error' || final.stopReason === 'aborted') {
              throw new Error(
                final.errorMessage ??
                  `nested subagent '${subagentType}' ended with stopReason='${final.stopReason}'`,
              );
            }
            const text = completedChildReport(final, childProgress, subagentType);
            this.emitFrame(
              piTaskUpdatedFrame({
                sessionId: this.sessionId,
                taskId,
                status: 'completed',
              }),
            );
            return text;
          } catch (error) {
            // An aborted child may either end its stream quietly (handled above)
            // or throw the abort — both must still close the durable task_* row.
            if (childSignal.aborted || this.abort.signal.aborted) {
              this.emitFrame(
                piTaskUpdatedFrame({ sessionId: this.sessionId, taskId, status: 'killed' }),
              );
            } else {
              this.emitFrame(
                piTaskUpdatedFrame({
                  sessionId: this.sessionId,
                  taskId,
                  status: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }
            throw error;
          }
        },
        { signal: signal ?? this.abort.signal },
      ),
  };

  /** Resolve a spec.model override: 'inherit'/unset → parent model; a pi
   *  catalog id resolves under the run's provider; anything else (SDK alias
   *  names like 'sonnet') fails closed. */
  private childModelFor(spec: PiSubagentSpec): PiModel<PiApi> {
    const declared = spec.model;
    if (declared === undefined || declared === 'inherit') return this.model;
    const resolved = this.deps.models.getModel(piProviderId(this.args.resolved.provider), declared);
    if (!resolved) {
      throw new Error(
        `pi adapter cannot resolve nested-agent model '${declared}' in provider '${this.args.resolved.provider}' — declare a pi catalog id or 'inherit' (SDK alias names are not portable).`,
      );
    }
    return resolved;
  }

  private async *iterate(promptsPromise: Promise<AgentMessage[]>): AsyncGenerator<RunnerMessage> {
    const { options } = this.args;
    const prompts = await promptsPromise;
    // Skill docs: SDK injected SKILL.md via a filesystem mirror; pi appends the
    // bodies to the system prompt (same model-visible contract, no Skill tool).
    let systemPrompt = composePiSystemPrompt(
      typeof options.systemPrompt === 'string'
        ? options.systemPrompt
        : (() => {
            throw new Error(
              'pi adapter requires a plain string systemPrompt (claude_code presets are SDK-only)',
            );
          })(),
      this.args.piSkillDocs,
      this.args.options.transportEvidence?.optionalDependencyUnavailable,
    );
    const structuredOutput = toolOutputSchema(this.args.kind) !== undefined;
    const submitPolicy = structuredOutput ? this.wire.submitPolicy(this.model) : undefined;
    const definition: TaskDefinition = tasks[this.args.kind];
    // YUK-1904 — a unit plan switches the submit contract to one unit per call.
    const unitPlan = structuredOutput
      ? definition.structuredSubmitUnits?.(this.args.structuredSubmitInput)
      : undefined;
    const executionDeadline =
      Date.now() + (this.args.executionWindowMs ?? Number.POSITIVE_INFINITY);
    const submitLoop = structuredOutput
      ? createStructuredSubmitLoop({
          schema: toolOutputSchema(this.args.kind, this.args.structuredSubmitInput),
          parameters: this.toolSurface.tools.find((tool) => tool.name === STRUCTURED_OUTPUT_TOOL)
            ?.parameters,
          taskInput: this.args.structuredSubmitInput,
          ...(unitPlan ? { units: unitPlan } : {}),
          ...(unitPlan ? { fullSchema: definition.structuredOutputSchema } : {}),
          forced: submitPolicy?.forced ?? true,
          runId: this.args.runId,
          correctionDeadline: executionDeadline - NO_PROGRESS_BUDGET_LANDING_MARGIN_MS,
          executionDeadline,
          executableTools: new Set(
            this.toolSurface.tools
              .map((tool) => tool.name)
              .filter((name) => name !== STRUCTURED_OUTPUT_TOOL),
          ),
          ...(typeof options.maxTurns === 'number' ? { toolTurnLimit: options.maxTurns } : {}),
        })
      : undefined;
    if (structuredOutput) {
      systemPrompt += unitPlan
        ? structuredSubmitUnitSuffix(submitPolicy?.forced ?? true)
        : structuredSubmitSystemSuffix(submitPolicy?.forced ?? true);
    }
    const context: AgentContext = {
      // Durable-turn replay seeds context.messages — the pi equivalent of
      // reattaching an SDK session file.
      messages: [
        { role: 'system', content: systemPrompt, timestamp: Date.now() },
        ...piReplayTurnsToMessages(this.args.piSessionReplay ?? [], this.model),
      ],
      ...(this.toolSurface.tools.length > 0 ? { tools: this.toolSurface.tools } : {}),
    };
    // options.maxTurns is the runner's agentic-turn ceiling; pi has no built-in
    // equivalent, so finishTurn counts turns and the terminal reports
    // 'error_max_turns'. YUK-1026 — the ceiling only bites when the agent wants
    // ANOTHER turn: a clean end_turn ends successfully, because under an
    // unconditional counter every maxTurns=1 task failed after its first turn.
    const maxTurns = typeof options.maxTurns === 'number' ? options.maxTurns : undefined;
    let cappedByMaxTurns = false;
    // Structured submission closes by validation, progress and budget; only its
    // tool-work turns count against the turn ceiling, inside the submit loop.
    const costCeiling =
      typeof options.maxBudgetUsd === 'number'
        ? createPiCostCeiling({
            maxBudgetUsd: options.maxBudgetUsd,
            stopWithoutClosingTurn: structuredOutput,
            provider: this.args.resolved.provider,
            model: this.args.resolved.model,
            authMode: this.args.resolved.authMode,
          })
        : undefined;
    const rootTurnLimiter =
      maxTurns !== undefined
        ? turnLimiter(maxTurns, () => {
            cappedByMaxTurns = true;
          })
        : undefined;
    // Strict raw JSON is checked independently of pi's best-effort argument parser.
    const rawToolArguments = new Map<number, string>();
    const streamedArgsByCallId = new Map<string, string>();
    let invalidStructuredArguments = false;
    // pi only enqueues events; it does not wait for this consumer. Gate
    // scheduling on observing the SAME assistant message pi passes to
    // finishTurn, so a nested loop's events cannot acknowledge the root.
    let observedStructuredMessage: PiAssistantMessage | undefined;
    let acknowledgeStructuredMessage: ((message: PiAssistantMessage) => void) | undefined;
    const config: AgentLoopConfig = {
      model: this.model,
      ...this.wire.loopConfig(),
      // SDK in-process MCP tools run serially — pin the same mode so ordering and
      // the tool_call_log sequence cannot diverge by engine.
      ...(this.toolSurface.tools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
      ...(structuredOutput
        ? {
            finishTurn: (async ({ message, toolResults }) => {
              if (observedStructuredMessage !== message && !this.abort.signal.aborted) {
                await new Promise<void>((resolve) => {
                  const done = () => {
                    this.abort.signal.removeEventListener('abort', done);
                    acknowledgeStructuredMessage = undefined;
                    resolve();
                  };
                  acknowledgeStructuredMessage = (observed) => {
                    if (observed === message) done();
                  };
                  this.abort.signal.addEventListener('abort', done, { once: true });
                });
              }
              if (
                this.abort.signal.aborted ||
                observedStructuredMessage !== message ||
                message.stopReason === 'error' ||
                message.stopReason === 'aborted'
              )
                return { action: 'end' as const };
              return submitLoop?.finishTurn(
                { message, toolResults },
                invalidStructuredArguments,
                this.toolSurface.repairedArguments(STRUCTURED_OUTPUT_TOOL),
                message.content
                  .filter((block) => block.type === 'toolCall')
                  .map((call) => streamedArgsByCallId.get(call.id)),
              );
            }) satisfies FinishTurn,
            prepareNextTurn: () => {
              const feedback = submitLoop?.takeFeedback();
              return feedback ? { messages: [piUserMessage(feedback)] } : undefined;
            },
          }
        : {
            // Non-structured root loops share the run-scoped correction allowance
            // too; the caller's turn ceiling keeps its normal meaning under it.
            finishTurn: this.contractCorrectionFinishTurn(
              costCeiling ? costCeiling.finishTurn(rootTurnLimiter) : rootTurnLimiter,
            ),
            ...(costCeiling ? { prepareNextTurn: costCeiling.prepareNextTurn } : {}),
          }),
      beforeToolCall: costCeiling
        ? costCeiling.beforeToolCall(this.makeBeforeToolCall())
        : this.makeBeforeToolCall(),
      afterToolCall: this.makeAfterToolCall(),
      transformContext: this.makeTransformContext(),
      // YUK-1022 — steering/follow-up sources are wired on the ROOT loop only:
      // steering targets the running turn and nested loops must not drain a
      // parent queue. No caller provides these today.
      ...(this.args.piQueues?.getSteeringMessages
        ? { getSteeringMessages: this.args.piQueues.getSteeringMessages }
        : {}),
      ...(!structuredOutput && this.args.piQueues?.getFollowUpMessages
        ? {
            getFollowUpMessages: async () => {
              try {
                return (await this.args.piQueues?.getFollowUpMessages?.()) ?? [];
              } catch {
                return [];
              }
            },
          }
        : {}),
    };

    if (structuredOutput && costCeiling)
      config.finishTurn = costCeiling.finishTurn(config.finishTurn);

    const startedAt = Date.now();
    let numTurns = 0;
    let finalMessages: AgentMessage[] = [];
    // SDK parity: every query emits an init frame; the consume loop reads its
    // session_id (notifySdkSessionId) — pi carries the `pi:`-prefixed id.
    yield piInitFrame({
      sessionId: this.sessionId,
      model: this.model,
      tools: this.toolSurface.tools,
    });
    // Only this root invocation sees the observed fetch. Children keep the
    // original streamFn; neither their responses nor query.latest prove root failure.
    const rootRejections = new WeakMap<PiAssistantMessage, number>();
    const rootStreamFn: StreamFn = async (model, llmContext, streamOptions) => {
      const collector = options.transportEvidence;
      const before = collector?.snapshot();
      const originalFetch = streamOptions?.fetch;
      let fetchCount = 0;
      let rootResponse: Response | undefined;
      const responseStream = await this.wire.streamFn(
        model,
        llmContext,
        originalFetch
          ? {
              ...streamOptions,
              fetch: async (...args) => {
                fetchCount += 1;
                // Attribute this fetch to the root loop: `beginFetch` consumes
                // the mark synchronously down the fetch chain, so a nested
                // loop's requests stay unmarked. The finally clears a mark
                // whose fetch never reached the instrumented transport.
                collector?.noteFetchLoop('root');
                try {
                  const response = await originalFetch(...args);
                  rootResponse = fetchCount === 1 ? response : undefined;
                  return response;
                } finally {
                  collector?.noteFetchLoop(undefined);
                }
              },
            }
          : streamOptions,
      );
      // Observe the same completion promise before the engine receives the stream;
      // consuming queued message_end events can be too late to exclude tool work.
      void responseStream
        .result()
        .then((assistant) => {
          const after = collector?.snapshot();
          const boundStatus =
            rootResponse !== undefined && !rootResponse.ok ? rootResponse.status : undefined;
          if (
            !before ||
            !after ||
            fetchCount !== 1 ||
            boundStatus === undefined ||
            rootResponse?.redirected ||
            assistant.stopReason !== 'error' ||
            this.abort.signal.aborted ||
            before.requests_dropped !== 0 ||
            after.requests_dropped !== 0 ||
            before.requests.some((request) => !request.ended_at || !request.fetch_settled_at) ||
            after.requests_seen - before.requests_seen !== 1 ||
            after.totals.dispatches - before.totals.dispatches !== 1
          )
            return;
          const request = after.requests.at(-1);
          if (
            request?.lane === 'undici_agent' &&
            request.fetch_outcome === 'response' &&
            request.send_state === 'response_received' &&
            request.http_status === boundStatus &&
            request.response_headers_at &&
            request.fetch_settled_at &&
            request.ended_at &&
            !request.signal_aborted &&
            !request.timeout_layer &&
            !request.error
          ) {
            rootRejections.set(assistant, boundStatus);
          }
        })
        .catch(() => {});
      return responseStream;
    };
    if (!structuredOutput)
      installLoopProgress(config, this.toolSurface.tools, this.args.piHooks, {
        loopId: this.sessionId,
      });
    const retryBound = interruptedRequestRetryBound(this.args.kind);
    const loopStreamFn =
      retryBound === undefined
        ? rootStreamFn
        : retryInterruptedRequest(rootStreamFn, {
            bound: retryBound,
            interruption: () => {
              const request = options.transportEvidence?.snapshot().requests.at(-1);
              return providerRequestInterruption({
                idleFired: this.wire.idleFailed(),
                request: request?.loop === 'root' ? request : undefined,
                aborted: this.abort.signal.aborted,
              });
            },
            beforeResend: (dead, llmContext) => {
              this.wire.releaseIdleFailure();
              this.chargeDeadRequest(dead, llmContext.messages);
            },
            signal: this.abort.signal,
          });
    const stream = this.deps.agentLoop(prompts, context, config, this.abort.signal, loopStreamFn);
    let textStreamed = false;
    // What the current provider request has streamed out — what a resend retracts.
    let requestTextChars = 0;
    let requestThinkingChars = 0;
    for await (const event of stream) {
      if (event.type === 'message_start' && event.message.role === 'assistant') {
        requestTextChars = 0;
        requestThinkingChars = 0;
      }
      const retryNotice =
        event.type === 'message_update'
          ? requestRetryMarkers.get(event.assistantMessageEvent)
          : undefined;
      if (retryNotice !== undefined) {
        yield* this.drainFrames();
        // The dead attempt's partial tool arguments must not prefix the resend's.
        rawToolArguments.clear();
        streamedArgsByCallId.clear();
        yield {
          type: 'system',
          subtype: 'request_retry',
          retry: retryNotice.retry,
          max_retries: retryNotice.maxRetries,
          reason: retryNotice.reason,
          delay_ms: retryNotice.delayMs,
          discarded_text_chars: requestTextChars,
          discarded_thinking_chars: requestThinkingChars,
          uuid: randomUUID(),
          session_id: this.sessionId,
          source: 'pi',
        };
        requestTextChars = 0;
        requestThinkingChars = 0;
        textStreamed = false;
        continue;
      }
      // A new assistant turn restarts the raw-arguments window: content indexes
      // repeat per message, so without the reset a rejected submit's bytes would
      // concatenate with the corrected call's and corrupt the strict-JSON check.
      this.toolSurface.trackStreamedArgs(event, rawToolArguments, streamedArgsByCallId);
      if (event.type === 'turn_start') {
        invalidStructuredArguments = false;
        this.toolSurface.clearRepairedArguments(STRUCTURED_OUTPUT_TOOL);
      }
      this.toolSurface.observeToolAttempt(event, streamedArgsByCallId, this.abort.signal.aborted);
      this.toolSurface.observeToolArgsProgress(event, rawToolArguments);
      // Frames queued inside the loop surface before the engine event that
      // follows them, matching the SDK wire order (lifecycle frame → tool_result).
      yield* this.drainFrames();
      if (
        event.type === 'message_update' &&
        event.message.role === 'assistant' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        const text = event.assistantMessageEvent.delta;
        if (text.length > 0 && !this.abort.signal.aborted) {
          textStreamed = true;
          requestTextChars += text.length;
          yield { type: 'text_delta', text, session_id: this.sessionId, source: 'pi' };
        }
        continue;
      }
      if (
        event.type === 'message_update' &&
        event.message.role === 'assistant' &&
        event.assistantMessageEvent.type === 'thinking_delta'
      ) {
        const text = event.assistantMessageEvent.delta;
        if (text.length > 0 && !this.abort.signal.aborted) {
          requestThinkingChars += text.length;
          yield { type: 'thinking_delta', text, session_id: this.sessionId, source: 'pi' };
        }
        continue;
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (structuredOutput) {
          // pi's parser may repair malformed tool JSON. That hidden repair must
          // not consume an untracked allowance: reject salvaged output and fail
          // closed on missing raw deltas.
          event.message.content.forEach((block, index) => {
            // The strict check guards the submitted output; other tools'
            // arguments are validated by their own schemas when they execute.
            if (block.type !== 'toolCall' || block.name !== STRUCTURED_OUTPUT_TOOL) return;
            try {
              JSON.parse(rawToolArguments.get(index) ?? '');
            } catch {
              invalidStructuredArguments = true;
            }
          });
          observedStructuredMessage = event.message;
          acknowledgeStructuredMessage?.(event.message);
        }
        numTurns += 1;
        yield {
          ...piAssistantToSdkFrame(event.message as PiAssistantMessage, this.sessionId),
          ...(textStreamed ? { text_streamed: true } : {}),
        };
        textStreamed = false;
        continue;
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        yield piToolResultToSdkFrame(event.message as PiToolResultMessage, this.sessionId);
        continue;
      }
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }
    yield* this.drainFrames();
    const finalAssistant = lastAssistantMessage(finalMessages);
    // A final tool-work turn streams other tools' arguments; those are not submit evidence.
    const submitRawArguments = [...rawToolArguments.entries()]
      .filter(([index]) => {
        const block = finalAssistant?.content[index];
        return !(block?.type === 'toolCall' && block.name !== STRUCTURED_OUTPUT_TOOL);
      })
      .map(([, raw]) => raw);
    const boundRootStatus =
      finalAssistant && !this.abort.signal.aborted && !cappedByMaxTurns
        ? rootRejections.get(finalAssistant)
        : undefined;
    // Any bound non-2xx feeds provider_http_status; the narrower 400/429/502
    // subset keeps its existing rejection/fault semantics.
    const boundRootRejection = rootBoundProviderStatus(boundRootStatus);
    // The capture keeps the latest non-2xx across ALL of this query's requests
    // (retries + nested loops), so it is probative only when the request live
    // at termination itself was non-2xx. The snapshot's tail is the
    // chronologically last request (the collector keeps the most recent
    // records); it must additionally be one the ROOT loop issued — a nested
    // loop's tail failure is the child's evidence, not the root's terminal
    // cause.
    const lastRequest = options.transportEvidence?.snapshot().requests.at(-1);
    const lastRequestStatus = lastRequest?.loop === 'root' ? lastRequest.http_status : undefined;
    const terminalRequestStatus =
      lastRequestStatus !== undefined && lastRequestStatus >= 400 ? lastRequestStatus : undefined;
    this.wire.applyFailure(lastAssistantMessage(finalMessages));
    const terminal = piTerminalResultFrame({
      messages: finalMessages,
      model: this.model,
      sessionId: this.sessionId,
      durationMs: Date.now() - startedAt,
      numTurns,
      // The internal controller is the single abort truth: it fires on caller
      // signal abort (wired in the constructor) and on close().
      aborted: this.abort.signal.aborted,
      cappedByMaxTurns,
      structuredOutputTool: structuredOutput,
      invalidStructuredArguments,
      // Known incomplete submissions use the existing sealed failure receipt.
      structuredSubmitFailure:
        structuredOutput && !submitLoop?.accepted
          ? (submitLoop?.failure ?? (costCeiling?.closed ? 'max_budget_usd' : 'validation_failed'))
          : undefined,
      structuredSubmitFailureDetail: submitLoop?.failureDetail,
      // YUK-1904 — unit submits assemble inside the loop; the final message only
      // carries the last accepted unit, so the terminal prefers the assembled output.
      structuredAssembledOutput: structuredOutput ? submitLoop?.assembled() : undefined,
      // What validation/execute actually saw after the shared repair — the
      // capability receives this, not the still-stringified raw fields.
      repairedSubmitArguments: this.toolSurface.repairedArguments(STRUCTURED_OUTPUT_TOOL),
      structuredSubmitEvidence:
        structuredOutput && submitRawArguments.length > 0
          ? {
              tool_name: STRUCTURED_OUTPUT_TOOL,
              // Same C6 boundary as per-call evidence — streamed bytes can carry
              // credential keys inside embedded JSON string fields.
              ...rawArgumentsEvidence(
                submitRawArguments
                  .map((raw) =>
                    sanitizeArgumentsEvidenceText(raw, {
                      secrets:
                        this.args.resolved.authMode !== 'oauth-file' && this.args.resolved.apiKey
                          ? [this.args.resolved.apiKey]
                          : [],
                    }),
                  )
                  .join('\n'),
              ),
            }
          : undefined,
      // YUK-1559 (C6) — last non-2xx this query's capture fetch saw, if any.
      providerError: this.wire.latestProviderError(),
      providerRequestRejection: boundRootRejection === 400 ? { http_status: 400 } : undefined,
      providerHttpStatus: boundRootStatus ?? terminalRequestStatus,
      helpProviderFault: (() => {
        const fault =
          boundRootRejection === undefined ? undefined : helpFaultForRootStatus(boundRootRejection);
        if (fault?.kind !== 'quota') return fault;
        // The bound 429's own body decides whether copy may name 额度.
        const body = this.wire.latestProviderError()?.body;
        return { ...fault, signed: providerQuotaLimitSigned(body !== undefined ? [body] : []) };
      })(),
      // Same shared boundary on errors[0] — pi's errorMessage can carry the
      // full unsanitized provider body and must not bypass redaction/cap.
      sanitizeErrorMessage: this.wire.sanitizeErrorMessage(),
      childUsage: this.childUsage,
    });
    if (terminal) {
      if (terminal.type === 'result' && terminal.subtype !== 'success' && this.wire.idleFailed())
        terminal.provider_failure = { ...terminal.provider_failure, stream_idle: true };
      yield costCeiling?.closed && terminal.type === 'result' && terminal.subtype === 'success'
        ? { ...terminal, stop_reason: MAX_BUDGET_STOP_REASON }
        : terminal;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Cooperative stop that mirrors SDK query.close().
    this.abort.abort();
    await this.wire.close();
    // Remote MCP clients hold sockets — release them with the session.
    for (const handle of this.remoteMcpHandles) {
      try {
        await handle.close();
      } catch {
        // Transport teardown must never turn a settled run into a failure.
      }
    }
  }
}

export class PiAgentAdapter implements ExecutionAdapter {
  readonly id = 'pi' as const;
  private resolved: Required<PiAdapterDeps> | undefined;
  private customProvidersStamp: string | undefined;

  constructor(private readonly init: PiAdapterDeps = {}) {}

  /**
   * Lazy dependency resolution: the module-level singleton must not build the
   * provider catalog on import, and migrate.cjs reaches this module while
   * build:migrate marks @earendil-works/* external — static requires would crash
   * the migrate container at load.
   */
  private async resolveDeps(): Promise<Required<PiAdapterDeps>> {
    const customProvidersStamp = JSON.stringify(customProviderDefinitions());
    if (this.resolved === undefined) {
      // Each import evaluates only when its injected dep is absent.
      this.resolved = {
        // Anthropic-sub selects the native Anthropic preset with the OAuth
        // credential resolved separately.
        models: this.init.models ?? (await createLoomPiModels()),
        agentLoop: this.init.agentLoop ?? (await import('@earendil-works/pi-agent-core')).agentLoop,
        connectRemoteMcp: this.init.connectRemoteMcp ?? connectPiRemoteMcp,
      };
      this.customProvidersStamp = customProvidersStamp;
    } else if (!this.init.models && this.customProvidersStamp !== customProvidersStamp) {
      // Pi registers provider transports/auth once; live catalog facts alone
      // cannot add a provider or replace its protocol/credential binding.
      const models = await createLoomPiModels();
      this.resolved = { ...this.resolved, models };
      this.customProvidersStamp = customProvidersStamp;
    }
    return this.resolved;
  }

  /**
   * Build the pi-side tool surface from declarative mounts, filtered by the same
   * effective allowedTools the SDK lane enforces. Wire names stay
   * `mcp__<server>__<tool>` so allowlist matching is verbatim.
   */
  private async buildTools(
    args: ExecutionAdapterStartupArgs,
    deps: Required<PiAdapterDeps>,
  ): Promise<{ tools: AgentTool[]; remoteHandles: PiRemoteMcpMountHandle[] }> {
    const mounts: PiToolMount[] = args.piToolMounts ?? [];
    const allowed = Array.isArray(args.options.tools)
      ? new Set(args.options.tools as string[])
      : undefined;
    const tools: AgentTool[] = [];
    const remoteHandles: PiRemoteMcpMountHandle[] = [];
    const outputSchema = toolOutputSchema(args.kind, args.structuredSubmitInput);
    if (outputSchema) {
      const definition: TaskDefinition = tasks[args.kind];
      // YUK-1904 — unit plans validate one unit per submit call.
      const unitPlan = definition.structuredSubmitUnits?.(args.structuredSubmitInput);
      tools.push(
        piCustomTool(
          'structured_output',
          'submit',
          unitPlan
            ? 'Submit ONE unit object as arguments. Correct the reported field/shape errors for a rejected unit and resubmit that unit; never resubmit an accepted unit.'
            : 'Submit the complete output object as arguments. Correct rejected field/shape errors and resubmit until accepted.',
          outputSchema,
          async (output) => {
            const parsed = outputSchema.safeParse(output);
            const errors = parsed.success
              ? [...(unitPlan?.validateUnit?.(parsed.data, args.structuredSubmitInput) ?? [])]
              : ['Submit arguments must satisfy the declared output schema.'];
            if (errors.length) throw new Error(errors.join('\n'));
            return {
              content: [
                { type: 'text', text: unitPlan ? 'Unit accepted.' : 'Submission accepted.' },
              ],
            };
          },
        ),
      );
    }
    try {
      for (const mount of mounts) {
        if (mount.type === 'domain') {
          tools.push(
            ...buildPiDomainAgentTools({
              ...mount.options,
              // YUK-1557 — the runner owns the active run identity and stamps
              // every bridge row even when a tool's spend owner uses another id.
              logTaskRunId: args.runId,
            }),
          );
        } else if (mount.type === 'custom') {
          tools.push(...mount.tools);
        } else {
          const handle = await connectTaskRemoteMcp(mount, args, deps.connectRemoteMcp);
          if (handle) {
            remoteHandles.push(handle);
            tools.push(...handle.tools);
          }
        }
      }
    } catch (err) {
      for (const handle of remoteHandles) {
        await handle.close().catch(() => {});
      }
      throw err;
    }
    const visible = allowed === undefined ? tools : tools.filter((tool) => allowed.has(tool.name));
    return { tools: visible, remoteHandles };
  }

  async startup(args: ExecutionAdapterStartupArgs): Promise<PreparedExecutionQuery> {
    const deps = await this.resolveDeps();
    // Fail fast before the durable attempt row: an unknown model or unresolved
    // credential is a config error, not a paid call. key/oauth modes carry the
    // credential on `resolved.apiKey`; oauth-file resolves it via the store.
    if (
      typeof args.options.resume === 'string' &&
      args.options.resume.length > 0 &&
      args.piSessionReplay === undefined
    ) {
      throw new Error(
        'pi adapter cannot serve options.resume without ctx.piSessionReplay — there is no provider session file; replay the durable turns instead.',
      );
    }
    const model = deps.models.getModel(piProviderId(args.resolved.provider), args.resolved.model);
    if (!model) {
      throw new TaskConfigError(
        `pi adapter cannot execute '${args.resolved.provider}/${args.resolved.model}': protocol or required catalog facts (endpoint, reasoning, input modalities, context/output limits) are unknown. Model selection is unchanged.`,
      );
    }
    // Reasoning level must have exactly one writer: options.effort and the
    // task.<kind>.reasoning resolution both target the wire reasoning slot —
    // even an applied 'off'/'none' outcome, or the receipt would lie.
    if (args.options.effort !== undefined && args.resolved.reasoning !== undefined) {
      throw new TaskConfigError(
        `conflicting reasoning params for task '${args.kind}': options.effort='${args.options.effort}' and task.<kind>.reasoning level='${args.resolved.reasoning.requested}' both target the wire reasoning level — keep exactly one source.`,
      );
    }
    const { tools, remoteHandles } = await this.buildTools(args, deps);
    // Fail-closed rollout rule: a tool-loop kind with no pi-visible tools would
    // silently run tool-less. An explicitly empty `options.tools` is the caller's
    // declared intent to do exactly that (CopilotTask authoritativeReply), not a
    // mount misconfiguration.
    const explicitlyToolLess = Array.isArray(args.options.tools) && args.options.tools.length === 0;
    if (tasks[args.kind].needsToolCall && tools.length === 0 && !explicitlyToolLess) {
      throw new Error(
        `Task kind '${args.kind}' declares needsToolCall but no pi-visible tools mounted (piToolMounts empty or allowedTools filtered all). Mount domain tools via piDomainMount and/or remote MCP via piRemoteMcpMount.`,
      );
    }
    return new PiPreparedQuery(args, model, deps, tools, remoteHandles);
  }
}
