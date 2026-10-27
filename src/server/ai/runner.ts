// AI task runner — pi execution lane.
//
// Every path goes through the ExecutionAdapter seam, which resolves to
// PiAgentAdapter: one in-process agentLoop per query, normalized into the
// SDKMessage-shaped RunnerMessage vocabulary so the consume loop has a single
// implementation. Provider wire protocols stay the adapter's business.
//
// Memory-layer extensibility: `RunTaskCtx.middleware` applies uniformly across
// runTask / runAgentTask / streamTask.

import { createHash } from 'node:crypto';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import { AgentRunError, RETRY_ELAPSED_CAP_MS } from '@/ai/agent-run-error';
import type { PiToolMount } from '@/ai/pi-tool-mount';
import { installTaskOperationObserver } from '@/ai/task-observation';
import type { RunTaskResult } from '@/ai/task-result';
import type { TaskBudget, TaskDefinition } from '@/ai/task-spec';
import {
  type TaskBudgetOverride,
  type TaskKind,
  getLearnerLocale,
  getTaskSystemPrompt,
  resolveTaskBudget,
  tasks,
} from '@/capabilities/task-registry';
import { type PiSubagentSpec, isSpawnToolName } from '@/core/subagent-contract';
import type { PiHookBridge } from '@/core/tool-call-contract';
import type { Db } from '@/db/client';
import type { SubjectProfile } from '@/subjects/profile';
import { resolveProviderSessionDeadlineAt } from '../http/provider-session-deadline';
import type { R2Client } from '../r2';
import { bindAgentRunError, isApiErrorSuccessResult } from './agent-run-error';
import {
  type ModelBinding,
  type PiQueueSources,
  type PiReplayTurn,
  type PreparedExecutionQuery,
  type RunnerMessage,
  resolveExecutionAdapter,
} from './execution-adapter';
import { type TraceContent, traceMetadata, traceOperation } from './laminar-tracing';
import { logMissingToolMountsWarning } from './log';
import { providerHttpTimeoutMs } from './provider-http-timeout';
import { PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS } from './provider-session-admission';
import type { ProviderTransportCollector } from './provider-transport';
import type { ResolvedProvider } from './providers';
import {
  type AiRunLifecycle,
  AttemptSettlementError,
  classifyLifecycleRetry,
  createRunLifecycle,
  maxLifecycleAttempts,
} from './run-lifecycle';
import { createSdkTerminalEvidenceCollector } from './sdk-terminal';
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKUserMessage,
} from './sdk-types';
import { addStreamText, emptyStreamTextStats } from './timeout-usage';

// The runner is loaded before capability execution. Keep the shared observation
// contract backend-free while using the same async trace context as task/model spans.
installTaskOperationObserver((observation, execute) =>
  traceOperation(
    observation.taskKind === 'CopilotTask'
      ? observation.operation === 'run'
        ? 'copilot.run'
        : 'copilot.finalize'
      : 'task.run',
    {
      task_kind: observation.taskKind,
      task_run_id: observation.taskRunId,
      logical_run_id: observation.logicalRunId,
    },
    () => execute((business_outcome) => traceMetadata({ business_outcome })),
  ),
);

// ============================================================================
// Public surface
// ============================================================================

export type { RunTaskResult } from '@/ai/task-result';

export interface CompiledModelPrompt {
  text: string;
  codecVersion: string;
  mode: 'cold' | 'resume';
  contextDigest: string;
}

/**
 * Structural background-task lifecycle messages safe for product observers.
 * Assistant messages (including thinking/text blocks) are intentionally absent.
 */
export type TaskEventMessage =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage;

export type TaskEventObserver = (event: TaskEventMessage) => Promise<void> | void;

export type ProviderQueryStartContext = {
  readonly taskRunId: string;
  readonly provider: ResolvedProvider['provider'];
  readonly model: string;
};

export type BeforeProviderQuery = (context: ProviderQueryStartContext) => Promise<void>;

export interface TaskMiddleware {
  /**
   * Called once before the model invocation. Can return a transformed
   * input (e.g. memory module prepends recall context).
   */
  beforeRun?: (kind: string, input: unknown, ctx: RunTaskCtx) => Promise<unknown> | unknown;
  /**
   * Called once with the resolved result. Side-effects only — observation
   * logging, memory write. Errors caught + logged, never thrown back.
   */
  afterRun?: (kind: string, result: RunTaskResult, ctx: RunTaskCtx) => Promise<void> | void;
}

export interface RunTaskCtx {
  judgeRetryPolicy?: Options['judgeRetryPolicy'];
  db: Db;
  /** Per-run capability-owned sanitized content; omitted runs export metadata only. */
  laminarContent?: TraceContent<RunTaskResult>;
  /** Caller-owned cancellation propagated into the provider run lifecycle. */
  signal?: AbortSignal;
  /**
   * Stable controller shared with an in-process MCP ToolContext; the runner
   * aborts it on timeout/fencing/caller stop.
   */
  lifecycleAbortController?: AbortController;
  /** Only vision/ingestion paths use this; runTask itself doesn't dereference. */
  r2?: R2Client;
  /** Override provider/model for testing or per-call routing escapes. */
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  /**
   * YUK-921 / YUK-1013 — per-run model binding. Resolved inside the
   * `explicit > env > registry` order; `ctx.override` still wins per field. The
   * only legal `adapter` value is 'pi'.
   */
  modelBinding?: ModelBinding;
  /**
   * YUK-576 — in-process transient-retry opt-in, default OFF. ONLY call paths
   * with NO durable backstop may set it (today the two vision judges). Durable
   * pg-boss handlers must NOT: queue redelivery is their single transient layer
   * and stacking both multiplies worst-case paid calls. Even when set, retry
   * requires unpinned routing, a whitelisted transient failure, budget room, and
   * arrival within RETRY_ELAPSED_CAP_MS of the first attempt.
   */
  enableTransientRetry?: boolean;
  /**
   * Absolute wall-clock deadline for the whole provider session: admission,
   * startup and execution share it. Hono requests inherit one automatically;
   * durable workers omit it and keep the task's full budget.
   */
  providerSessionDeadlineAt?: number;
  /** Memory-layer hook surface. */
  middleware?: TaskMiddleware;
  /**
   * Override allowedTools. When omitted, runner uses `tasks[kind].allowedTools`
   * from the registry — single source of truth for what each task can call.
   * The adapter filters mounted AgentTools against these `mcp__<server>__<tool>`
   * wire names.
   */
  allowedTools?: string[];
  /** Subject context for prompts that are rendered from SubjectProfile. */
  subjectProfile?: SubjectProfile;
  /** Stable prompt language for this execution, including retries and provenance. */
  learnerLocale?: 'zh-CN' | 'en';
  /**
   * ADR-0060 — bounded session context re-injected after a budget prune. Never
   * contains raw summary/CoT; enabled only for the Copilot live-session lane.
   */
  nativeCompaction?: {
    /** Context to reintroduce after compaction; never raw summary/CoT. */
    sessionContext: string;
  };
  /** YUK-757 — structural task-lifecycle frames only; observer failures fail open. */
  onTaskEvent?: TaskEventObserver;
  /** YUK-457 — sanitized streaming tool_use observer; failures cannot abort paid work. */
  onToolUse?: (call: {
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  }) => void;
  /**
   * YUK-575 (N5/MF-A) — per-call budget override for durable copilot runs. The
   * registry default must stay untouched (YUK-458: raising it only turned
   * error_max_turns into an inline-request abort). Snapshotted before
   * middleware/admission/startup; retries retain that snapshot. 'unbounded'
   * removes the agentic-turn ceiling entirely.
   */
  budgetOverride?: TaskBudgetOverride;
  /** Correlation id shared with an in-process MCP server; a retry gets a fresh id. */
  taskRunId?: string;
  /** Runs after durable attempt creation and immediately before the prepared query submits its prompt. */
  beforeProviderQuery?: BeforeProviderQuery;
  /**
   * Active outer central attempt for a nested DomainTool run. Same-lane children
   * borrow the parent's session slot so maxConcurrency=1 cannot deadlock; the DB
   * validates the parent lease.
   */
  parentTaskRunId?: string;
  /**
   * Disable runner-owned tool logging. DomainTools, custom mounts and remote MCP
   * write their own row (YUK-1557: one row per executed call).
   */
  autoLogToolCalls?: boolean;
  /**
   * YUK-936 (ADR-0054) — durable agent-session slot (historically the SDK
   * session-file id; now the `pi:` cursor). `persist` keeps the cursor,
   * `resume` replays `ctx.piSessionReplay`, `onSessionId` observes the minted id.
   * Set explicitly by chat.ts; omitted ⇒ no resume, no subscription.
   */
  sdkSession?: {
    persist: boolean;
    resume?: string;
    onSessionId?: (sessionId: string) => void | Promise<void>;
  };
  compiledModelPrompt?: CompiledModelPrompt;
  /**
   * YUK-921 P2 (YUK-1021) — THE tool mount surface. needsToolCall kinds must
   * mount at least one visible tool; the adapter fails closed otherwise.
   */
  piToolMounts?: PiToolMount[];
  /** YUK-1022 — ordered beforeToolCall gates + afterToolCall observers. */
  piHooks?: PiHookBridge;
  /** Replay turns seeded into `context.messages` when `sdkSession.resume` is set. */
  piSessionReplay?: readonly PiReplayTurn[];
  /** Resolved skill bodies appended to the pi system prompt. */
  piSkillDocs?: readonly { name: string; body: string }[];
  /** Depth-one nested-agent specs; mounts the `Task`/`Agent` AgentTool. */
  piAgents?: Record<string, PiSubagentSpec>;
  /** YUK-1022 — steering/follow-up sources for the root loop; no live caller yet. */
  piQueues?: PiQueueSources;
}

function compiledPromptProvenance(prompt?: CompiledModelPrompt) {
  if (!prompt) return undefined;
  return {
    compiledPromptHash: createHash('sha256').update(prompt.text, 'utf8').digest('hex'),
    promptCodecVersion: prompt.codecVersion,
    promptCodecMode: prompt.mode,
    promptContextDigest: prompt.contextDigest,
  };
}

export type RunAgentTaskCtx = RunTaskCtx;
export type StreamTaskCtx = RunTaskCtx & {
  /** Reserved for back-compat with the old Vercel AI SDK shape; ignored. */
  tools?: Record<string, unknown>;
};

export interface MultimodalTaskInput {
  text: string;
  images: Array<{
    /** base64-encoded image data (no "data:" prefix) or Buffer-like. URLs are
     *  not supported — the pi adapter carries base64 only; fetch and inline
     *  upstream. */
    data: string | Uint8Array;
    mediaType: string;
  }>;
}

// ============================================================================
// Internals
// ============================================================================

const TASK_KINDS = Object.keys(tasks) as TaskKind[];

function isKnownTask(k: string): k is TaskKind {
  return (TASK_KINDS as string[]).includes(k);
}

/**
 * YUK-1049 — typed-execution tasks (execution:'typed') are served ONLY by the
 * typed primitive runner; the chat façade cannot build a prompt for them
 * ({kind:'none'}). Fail closed at every chat entry instead of letting a
 * typed kind reach adapter startup / getTaskSystemPrompt.
 */
function assertChatExecutionKind(kind: TaskKind): void {
  // Literal-union read through the declared interface view (see
  // buildQueryOptions): `execution` is optional on TaskDefinition.
  if (((tasks[kind] as TaskDefinition).execution ?? 'chat') !== 'chat') {
    throw new Error(
      `task '${kind}' is a typed-execution task — use runTypedPrimitiveTask (src/server/ai/typed-primitive-runner.ts), not the chat entry points`,
    );
  }
}

function isTaskEventMessage(message: RunnerMessage): message is TaskEventMessage {
  if (message.type !== 'system') return false;
  switch (message.subtype) {
    case 'task_started':
    case 'task_progress':
    case 'task_updated':
    case 'task_notification':
      return true;
    default:
      return false;
  }
}

async function notifyTaskEvent(ctx: RunTaskCtx, message: RunnerMessage): Promise<void> {
  if (ctx.onTaskEvent === undefined || !isTaskEventMessage(message)) return;
  try {
    await ctx.onTaskEvent(message);
  } catch (error) {
    console.error('[runner] task event observer failed (continuing)', {
      subtype: message.subtype,
      task_id: message.task_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isMultimodalTaskInput(input: unknown): input is MultimodalTaskInput {
  if (input == null || typeof input !== 'object') return false;
  const candidate = input as { text?: unknown; images?: unknown };
  return (
    typeof candidate.text === 'string' &&
    Array.isArray(candidate.images) &&
    candidate.images.every((image) => {
      const img = image as { data?: unknown; mediaType?: unknown };
      return (
        img.data != null && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/')
      );
    })
  );
}

function imageDataToBase64(data: MultimodalTaskInput['images'][number]['data']): string {
  if (typeof data === 'string') return data;
  return Buffer.from(data).toString('base64');
}

function materializeMultimodalUserMessage(input: MultimodalTaskInput): SDKUserMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: input.text },
        ...input.images.map((img) => {
          const data = imageDataToBase64(img.data);
          if (data.startsWith('http://') || data.startsWith('https://')) {
            // pi carries base64 image data only — fail loudly here rather than
            // handing the adapter a block it must throw on mid-stream.
            throw new Error(
              'multimodal image data must be base64 — URL image sources are not ' +
                'supported (fetch the bytes and pass them inline)',
            );
          }
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data,
            },
          };
        }),
      ],
    },
  };
}

async function* singleMessagePromptIterable(
  userMessage: SDKUserMessage,
): AsyncGenerator<SDKUserMessage> {
  yield userMessage;
}

function promptFromInput(input: unknown): string | AsyncIterable<SDKUserMessage> {
  if (isMultimodalTaskInput(input)) {
    // Materialize image conversion now. An async-generator body is lazy, so
    // doing this inside the iterable would defer ArrayBuffer -> base64 work
    // until the SDK consumes the prompt after admission.
    return singleMessagePromptIterable(materializeMultimodalUserMessage(input));
  }
  if (typeof input === 'string') return input;
  return JSON.stringify(input);
}

/**
 * Build the per-attempt call spec for the adapter so the three entry points stay
 * consistent on tools-from-registry default, turn ceiling and session resume.
 * The pi surfaces live on `ctx.pi*` and are read by the adapter, not here.
 */
function buildQueryOptions(
  kind: TaskKind,
  ctx: RunTaskCtx,
  abortController: AbortController,
  // The caller resolves ONCE per attempt and threads the binding in (YUK-576):
  // single resolution per attempt keeps the retry loop's env/model provably
  // per-attempt-consistent.
  resolved: ResolvedProvider,
  budget: TaskBudget,
  transportEvidence?: ProviderTransportCollector,
): Options {
  // The registry map's value type is the union of every spec's inferred literal
  // shape; optional fields are read through this declared-interface view.
  const def = tasks[kind];
  const declaredDef: TaskDefinition = def;
  const options: Options = {
    judgeRetryPolicy: ctx.judgeRetryPolicy,
    model: resolved.model,
    systemPrompt: getTaskSystemPrompt(kind, ctx.subjectProfile, ctx.learnerLocale),
    abortController,
    tools: ctx.allowedTools ?? def.allowedTools,
    // YUK-575 (N5) — durable copilot run overrides the turn ceiling; 'unbounded'
    // removes it entirely.
    maxTurns: budget.maxIterations === 'unbounded' ? undefined : budget.maxIterations || 1,
    // YUK-1630 — the task budget is the single source for every provider HTTP
    // layer: this value is both the SDK timeout and the controlled dispatcher's
    // timer derivation (provider-transport.ts).
    providerTimeoutMs: providerHttpTimeoutMs(budget.timeout),
    transportEvidence,
  };
  // YUK-923 — per-run modelBinding effort wins over the task-kind declaration.
  const reasoningEffort = ctx.modelBinding?.effort ?? declaredDef.reasoningEffort;
  if (reasoningEffort !== undefined) {
    options.effort = reasoningEffort;
  }
  if (ctx.sdkSession?.persist && ctx.sdkSession.resume) {
    options.resume = ctx.sdkSession.resume;
  }
  return options;
}

async function notifySdkSessionId(ctx: RunTaskCtx, msg: { session_id?: string }): Promise<void> {
  const sessionId = msg.session_id;
  if (!sessionId || !ctx.sdkSession?.onSessionId) return;
  await ctx.sdkSession.onSessionId(sessionId);
}

/**
 * Start the adapter-resolved transport inside admission, then create the durable
 * attempt immediately before the one allowed query. Cleanup stays within the
 * admitted session boundary. YUK-1013 — `adapter.startup` is the single seam.
 */
async function withPreparedExecutionQuery<TResult extends RunTaskResult, TValue>(
  lifecycle: AiRunLifecycle<TResult>,
  modelBinding: ModelBinding | undefined,
  actualInput: unknown,
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options,
  consume: (query: AsyncIterable<RunnerMessage>) => Promise<TValue>,
  beforeProviderQuery?: BeforeProviderQuery,
  ctx?: RunTaskCtx,
): Promise<TValue> {
  // Resolved at the seam boundary so an unimplemented adapter pin throws the same
  // config-error posture before admission and before any durable row.
  const adapter = resolveExecutionAdapter(modelBinding, lifecycle.resolved, lifecycle.kind);
  let prepared: PreparedExecutionQuery | undefined;

  return lifecycle.withProviderSession(actualInput, {
    async prepare() {
      prepared = await adapter.startup({
        options,
        initializeTimeoutMs: lifecycle.providerPhaseTimeoutMs(
          PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS,
        ),
        resolved: lifecycle.resolved,
        runId: lifecycle.taskRunId,
        kind: lifecycle.kind,
        piToolMounts: ctx?.piToolMounts,
        // YUK-1022 — pi-lane descriptors for hooks, replay, skills, nested agents
        // and compaction; forwarded verbatim because the adapter needs the raw
        // sessionContext for transformContext.
        piHooks: ctx?.piHooks,
        piSessionReplay: ctx?.piSessionReplay,
        piSkillDocs: ctx?.piSkillDocs,
        piAgents: ctx?.piAgents,
        piQueues: ctx?.piQueues,
        nativeCompaction: ctx?.nativeCompaction,
      });
    },
    async run() {
      if (!prepared) throw new Error('adapter startup completed without a prepared query handle');
      await beforeProviderQuery?.({
        taskRunId: lifecycle.taskRunId,
        provider: lifecycle.resolved.provider,
        model: lifecycle.resolved.model,
      });
      return consume(prepared.query(prompt));
    },
    async close() {
      const p = prepared;
      prepared = undefined;
      await p?.close();
    },
  });
}

type SDKResultMessage = Extract<SDKMessage, { type: 'result' }>;
type SDKSuccessResultMessage = Extract<SDKResultMessage, { subtype: 'success' }>;
type SDKToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

/**
 * Consume one prepared query, keeping caller-owned lifecycle policy (retry,
 * settlement, stream cancellation, partial results) at each entrypoint.
 */
async function consumeProviderAttempt<TResult extends RunTaskResult>(args: {
  query: AsyncIterable<RunnerMessage>;
  kind: TaskKind;
  ctx: RunTaskCtx;
  lifecycle: AiRunLifecycle<TResult>;
  notifySessionId?: boolean;
  shouldRecordToolCall: (block: SDKToolUseBlock) => boolean;
  onAssistant?: (msg: SDKAssistantMessage) => Promise<void> | void;
  onTextDelta?: (text: string) => Promise<void> | void;
  onToolUse?: (block: SDKToolUseBlock) => void;
  onSuccess?: (msg: SDKSuccessResultMessage) => Promise<void> | void;
  onApiError?: (msg: SDKSuccessResultMessage) => void;
  apiErrorMessages?: (msg: SDKSuccessResultMessage) => string[];
  onResultError?: (msg: Exclude<SDKResultMessage, SDKSuccessResultMessage>) => void;
  abortedWithoutTerminalMessage: string;
  /** System prompt plus user prompt, used only when an abort has no provider usage. */
  usagePrompt?: string;
}): Promise<void> {
  const terminal = createSdkTerminalEvidenceCollector();
  let iteration = 0;
  let stepStartTime = Date.now();
  const modelStarted = Date.now();
  let firstTokenAt: number | undefined;
  const outputStats = emptyStreamTextStats();
  const settleUnobservedUsage = async () => {
    // YUK-1557 — a cut stream with no usage frame still submitted a prompt:
    // persist a bounded estimate, never a null cost. A reported frame wins.
    await args.lifecycle.recordEstimatedUsage({
      promptText: args.usagePrompt ?? '',
      output: outputStats,
      priceOrigin: args.lifecycle.aborted ? 'timeout-estimate' : 'failure-estimate',
    });
  };

  try {
    for await (const msg of args.query) {
      if (msg.type === 'text_delta' || msg.type === 'thinking_delta') {
        if (msg.text) {
          addStreamText(outputStats, msg.text);
          firstTokenAt ??= Date.now();
        }
        if (msg.type === 'text_delta' && !args.lifecycle.abortController.signal.aborted) {
          await args.onTextDelta?.(msg.text);
        }
        continue;
      }
      if (args.notifySessionId && msg.type === 'system' && msg.subtype === 'init') {
        await notifySdkSessionId(args.ctx, msg);
      }
      await notifyTaskEvent(args.ctx, msg);

      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        args.lifecycle.recordObservedUsage(terminal.observeCompaction(msg));
        continue;
      }

      // YUK-1547/YUK-1559 (C1/C6) — tool-argument contract telemetry, both keyed
      // to this task_run: adopted string→JSON repairs (tool/path/length only) and
      // sanitized ≤4KiB original arguments of a call rejected before execute.
      if (msg.type === 'system' && msg.subtype === 'tool_args_coerced') {
        await args.lifecycle.recordToolCall({
          toolName: msg.tool_name,
          inputJson: { event: 'coerced', tool_call_id: msg.tool_call_id, fields: msg.fields },
          errorReason: 'tool_args_coerced',
          iteration,
          latencyMs: 0,
        });
        continue;
      }
      if (msg.type === 'system' && msg.subtype === 'tool_args_contract_failed') {
        await args.lifecycle.recordToolCall({
          toolName: msg.tool_name,
          inputJson: {
            event: 'contract_failed',
            tool_call_id: msg.tool_call_id,
            args_source: msg.args_source,
            raw_arguments: msg.raw_arguments,
            raw_args_sha256: msg.raw_args_sha256,
            truncated: msg.truncated,
          },
          errorReason: 'tool_args_contract_failed',
          iteration,
          latencyMs: 0,
        });
        continue;
      }

      if (msg.type === 'assistant') {
        const observedUsage = terminal.observeAssistant(msg);
        if (observedUsage) args.lifecycle.recordObservedUsage(observedUsage);
        await args.onAssistant?.(msg);

        iteration += 1;
        const stepLatencyMs = Date.now() - stepStartTime;
        const blocks = (msg.message.content ?? []) as ContentBlock[];
        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;
          if (args.shouldRecordToolCall(block)) {
            await args.lifecycle.recordToolCall({
              toolName: block.name,
              inputJson: (block.input ?? {}) as Record<string, unknown>,
              iteration,
              latencyMs: stepLatencyMs,
            });
          }
          if (args.onToolUse) {
            try {
              args.onToolUse(block);
            } catch {
              // Visibility failures must never abort paid work.
            }
          }
        }
        stepStartTime = Date.now();
        continue;
      }

      if (msg.type !== 'result') continue;
      if (args.notifySessionId) await notifySdkSessionId(args.ctx, msg);
      args.lifecycle.recordTerminalResult(terminal.fromResult(msg));
      if (msg.subtype === 'success') {
        if (isApiErrorSuccessResult(msg)) {
          args.onApiError?.(msg);
          throw new AgentRunError({
            kind: args.kind,
            taskRunId: args.lifecycle.taskRunId,
            subtype: 'api_error_result',
            apiErrorStatus: msg.api_error_status ?? null,
            errors: args.apiErrorMessages?.(msg) ?? [msg.result ?? ''],
          });
        }
        await args.onSuccess?.(msg);
      } else {
        // YUK-1547 — a failed structured submit keeps its raw arguments as bounded
        // tool_call_log evidence so the unknown paid-effect row is diagnosable.
        const submitEvidence = (msg as { structured_submit_evidence?: Record<string, unknown> })
          .structured_submit_evidence;
        if (submitEvidence != null && typeof submitEvidence === 'object') {
          await args.lifecycle.recordToolCall({
            toolName:
              typeof submitEvidence.tool_name === 'string'
                ? submitEvidence.tool_name
                : 'mcp__structured_output__submit',
            inputJson: submitEvidence,
            iteration,
            latencyMs: Date.now() - stepStartTime,
            errorReason: 'structured_output_submit_arguments_rejected',
          });
        }
        args.onResultError?.(msg);
        throw new AgentRunError({
          kind: args.kind,
          taskRunId: args.lifecycle.taskRunId,
          subtype: msg.subtype,
          errors: 'errors' in msg && Array.isArray(msg.errors) ? msg.errors : [],
        });
      }
      break;
    }
  } catch (error) {
    await settleUnobservedUsage();
    throw error;
  } finally {
    const endedAt = Date.now();
    args.lifecycle.recordNotePhases({
      model_total_ms: endedAt - modelStarted,
      model_ttft_ms: firstTokenAt === undefined ? null : firstTokenAt - modelStarted,
      stream_ms: firstTokenAt === undefined ? 0 : endedAt - firstTokenAt,
    });
  }

  if (!args.lifecycle.sawTerminalResult) {
    if (args.lifecycle.aborted) {
      await settleUnobservedUsage();
      throw new Error(args.abortedWithoutTerminalMessage);
    }
    throw new AgentRunError({
      kind: args.kind,
      taskRunId: args.lifecycle.taskRunId,
      subtype: 'stream_no_terminal',
      errors: [],
    });
  }
}

/**
 * One attempt through the adapter. YUK-576 — the in-process transient-retry loop
 * only engages for opt-in call sites with unpinned routing; every other caller gets
 * one loom-level attempt.
 */
async function runTaskAttempt(args: {
  kind: TaskKind;
  actualInput: unknown;
  budget: TaskBudget;
  ctx: RunTaskCtx;
  lifecycle: AiRunLifecycle<RunTaskResult>;
  /** Effective binding after the env rollout pin — resolved once by the caller. */
  modelBinding: RunTaskCtx['modelBinding'];
  onProviderQueryStarted?: () => Promise<void>;
  warnMissingMcp?: boolean;
  retryCount?: number;
}): Promise<RunTaskResult> {
  const { kind, actualInput, budget, ctx, lifecycle, modelBinding } = args;

  let resultText = '';
  // Purely local preparation can do cold-start filesystem work (notably the
  // one-time skill mirror). Keep it outside the distributed lease: blocking after
  // acquire can delay the first heartbeat past its DB-derived deadline.
  const promptStarted = Date.now();
  const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
  const callOptions = buildQueryOptions(
    kind,
    ctx,
    lifecycle.abortController,
    lifecycle.resolved,
    budget,
    lifecycle.transportEvidence,
  );
  const usagePrompt = `${typeof callOptions.systemPrompt === 'string' ? callOptions.systemPrompt : ''}\n${typeof promptText === 'string' ? promptText : ''}`;
  lifecycle.recordNotePhases({
    prompt_build_ms: Date.now() - promptStarted,
    retry_count: args.retryCount ?? 0,
  });
  const consumePreparedQuery = async (q: AsyncIterable<RunnerMessage>) => {
    if (args.warnMissingMcp) {
      logMissingToolMountsWarning({
        task_run_id: lifecycle.taskRunId,
        task_kind: kind,
      });
    }
    await args.onProviderQueryStarted?.();
    await consumeProviderAttempt({
      query: q,
      kind,
      ctx,
      lifecycle,
      notifySessionId: true,
      shouldRecordToolCall: (block) =>
        isSpawnToolName(block.name) && ctx.autoLogToolCalls !== false,
      onSuccess: (msg) => {
        resultText = msg.result ?? '';
      },
      onApiError: (msg) => {
        console.warn('[runTask] task_run_success_with_error_flag', {
          event: 'task_run_success_with_error_flag',
          task_run_id: lifecycle.taskRunId,
          kind,
          api_error_status: msg.api_error_status ?? null,
        });
      },
      onResultError: (msg) => {
        if (msg.subtype === 'error_max_structured_output_retries') {
          console.warn(`[${kind}] structured-output retries exhausted`, {
            task_run_id: lifecycle.taskRunId,
          });
        }
      },
      abortedWithoutTerminalMessage: `[${kind}] Agent SDK run aborted (budget timeout) with no terminal result`,
      usagePrompt,
    });
  };
  await withPreparedExecutionQuery(
    lifecycle,
    modelBinding,
    actualInput,
    promptText,
    callOptions,
    consumePreparedQuery,
    ctx.beforeProviderQuery,
    ctx,
  );

  // The provider permit is released before attempt settlement / afterRun. A DB
  // observation write must never occupy scarce upstream session capacity.
  const result: RunTaskResult = {
    task_run_id: lifecycle.taskRunId,
    text: resultText,
    finishReason: lifecycle.finishReason,
    usage: lifecycle.usage,
    cost_usd: lifecycle.costUsd,
    cost_basis: lifecycle.costBasis,
    cost_ref: lifecycle.costRef,
    structured_output: lifecycle.structuredOutput,
    ...(lifecycle.usage.phases ? { phases: lifecycle.usage.phases } : {}),
  };
  await lifecycle.finishSuccess(result);
  return result;
}

/** Default chat entry. Tasks without `allowedTools` get an empty tool list and behave
 *  like a single-turn query. */
export async function runTask(
  kind: string,
  input: unknown,
  initialCtx: RunTaskCtx,
): Promise<RunTaskResult> {
  const ctx = { ...initialCtx, learnerLocale: initialCtx.learnerLocale ?? getLearnerLocale() };
  return traceOperation('task.run', { task_kind: kind }, () => runTaskImpl(kind, input, ctx), {
    signal: ctx.signal,
    content: ctx.laminarContent,
  });
}

async function runTaskImpl(kind: string, input: unknown, ctx: RunTaskCtx): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  assertChatExecutionKind(kind);
  const budget = resolveTaskBudget(kind, ctx.budgetOverride);
  const def = tasks[kind];

  // beforeRun runs exactly once, OUTSIDE the attempt loop — every attempt sees
  // the same transformed input and therefore the same input_hash.
  const actualInput = ctx.middleware?.beforeRun
    ? await ctx.middleware.beforeRun(kind, input, ctx)
    : input;

  const modelBinding = ctx.modelBinding;
  // Narrow pass, not {...ctx}: RunTaskCtx consumers may define lazy getters
  // (allowedTools et al.) whose evaluation must stay single-shot and ordered.
  const maxAttempts =
    ctx.judgeRetryPolicy === 'none'
      ? 1
      : maxLifecycleAttempts(budget.transientRetries, {
          enableTransientRetry: ctx.enableTransientRetry,
          override: ctx.override,
          modelBinding,
        });
  const firstAttemptStartedAt = Date.now();
  const retryingSyncDeadlineAt =
    maxAttempts > 1 ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS + budget.timeout : undefined;
  const callerProviderSessionDeadlineAt = resolveProviderSessionDeadlineAt(
    ctx.providerSessionDeadlineAt,
  );
  const providerSessionDeadlineAt =
    callerProviderSessionDeadlineAt === undefined
      ? retryingSyncDeadlineAt
      : retryingSyncDeadlineAt === undefined
        ? callerProviderSessionDeadlineAt
        : Math.min(callerProviderSessionDeadlineAt, retryingSyncDeadlineAt);

  let lastErr: unknown;
  let retrySource: AiRunLifecycle<RunTaskResult> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const lifecycle = createRunLifecycle<RunTaskResult>({
      db: ctx.db,
      kind,
      timeoutMs: budget.timeout,
      timeoutSource: budget.timeoutSource,
      abortController: ctx.lifecycleAbortController,
      override: ctx.override,
      modelBinding,
      parentTaskRunId: ctx.parentTaskRunId,
      // A retry may only wait inside the unused remainder of the existing 10s
      // sync-route gate. Admission must not silently expand the 100s worst-case
      // edge bound into maxWait + another full model budget.
      providerStartDeadlineAt:
        retrySource !== undefined ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS : undefined,
      providerSessionDeadlineAt,
      taskRunId: attempt === 1 ? ctx.taskRunId : undefined,
      signal: ctx.signal,
      logScope: 'runTask',
      compiledPromptProvenance: compiledPromptProvenance(ctx.compiledModelPrompt),
      afterRun: ctx.middleware?.afterRun
        ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
        : undefined,
    });
    try {
      return await lifecycle.withTracing(() =>
        runTaskAttempt({
          kind,
          actualInput,
          budget,
          ctx,
          lifecycle,
          modelBinding,
          retryCount: attempt - 1,
          // needsToolCall with no pi-visible mounts runs tool-less — warn once.
          warnMissingMcp: attempt === 1 && def.needsToolCall && !ctx.piToolMounts?.length,
          onProviderQueryStarted: retrySource
            ? async () => {
                await retrySource?.markRetried();
                retrySource = undefined;
              }
            : undefined,
        }),
      );
    } catch (err) {
      // Admission timeout/rejection happens before durable model-attempt start.
      // It has an admission row but no YUK-841 cost attempt and is never retried
      // by the runner's provider-transient loop.
      if (!lifecycle.started) throw err;
      // YUK-1557 — failures outside consumeProviderAttempt (startup/transport)
      // still need non-null estimated cost evidence.
      const fallbackPrompt = promptFromInput(actualInput);
      await lifecycle.recordEstimatedUsage({
        promptText: typeof fallbackPrompt === 'string' ? fallbackPrompt : '',
        output: emptyStreamTextStats(),
        priceOrigin: 'failure-estimate',
      });
      const boundError = bindAgentRunError({
        error: err,
        kind,
        taskRunId: lifecycle.taskRunId,
        aborted: lifecycle.aborted,
        costUsd: lifecycle.costUsd,
      });
      lastErr = boundError;
      const retry = classifyLifecycleRetry({
        attempt,
        maxAttempts,
        firstAttemptStartedAt,
        error: boundError,
      });
      // Settle the full truth before another provider call is allowed. The
      // actual-retry marker is a later, conservative transition performed only
      // after the next provider query has actually submitted its prompt.
      const settled = await lifecycle.finishFailure(boundError, 'error');
      if (!settled) throw boundError;
      if (!retry.willRetry) throw boundError;
      retrySource = lifecycle;
      console.warn('[runTask] task_run_transient_retry', {
        event: 'task_run_transient_retry',
        kind,
        task_run_id: lifecycle.taskRunId,
        attempt,
        elapsed_ms: retry.elapsedMs,
      });
    } finally {
      lifecycle.dispose();
    }
  }
  // Unreachable: the final attempt either returned or threw above. Kept for
  // exhaustiveness (and to satisfy control-flow analysis without a cast).
  throw lastErr;
}

/** Alias kept for callers that phrase intent as a tool-call loop; same behaviour. */
export async function runAgentTask(
  kind: string,
  input: unknown,
  ctx: RunAgentTaskCtx,
): Promise<RunTaskResult> {
  return runTask(kind, input, ctx);
}

/** Text-stream Response over the same pi path; tool-use blocks land in tool_call_log. */
export function streamTask(kind: string, input: unknown, initialCtx: StreamTaskCtx): Response {
  const ctx = { ...initialCtx, learnerLocale: initialCtx.learnerLocale ?? getLearnerLocale() };
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  assertChatExecutionKind(kind);
  const budget = resolveTaskBudget(kind, ctx.budgetOverride);
  const modelBinding = ctx.modelBinding;
  const lifecycle = createRunLifecycle<RunTaskResult>({
    db: ctx.db,
    kind,
    timeoutMs: budget.timeout,
    timeoutSource: budget.timeoutSource,
    abortController: ctx.lifecycleAbortController,
    override: ctx.override,
    modelBinding,
    parentTaskRunId: ctx.parentTaskRunId,
    providerSessionDeadlineAt: resolveProviderSessionDeadlineAt(ctx.providerSessionDeadlineAt),
    taskRunId: ctx.taskRunId,
    signal: ctx.signal,
    logScope: 'streamTask',
    compiledPromptProvenance: compiledPromptProvenance(ctx.compiledModelPrompt),
    afterRun: ctx.middleware?.afterRun
      ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
      : undefined,
  });
  let clientCancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await traceOperation(
        'task.run',
        { task_kind: kind },
        () =>
          lifecycle.withTracing(async () => {
            const encoder = new TextEncoder();
            let resultText = '';
            let shouldClose = true;
            let usagePromptText = '';

            try {
              const actualInput = ctx.middleware?.beforeRun
                ? await ctx.middleware.beforeRun(kind, input, ctx)
                : input;
              const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
              usagePromptText = typeof promptText === 'string' ? promptText : '';
              const callOptions = buildQueryOptions(
                kind,
                ctx,
                lifecycle.abortController,
                lifecycle.resolved,
                budget,
                lifecycle.transportEvidence,
              );
              const consumePreparedQuery = async (q: AsyncIterable<RunnerMessage>) => {
                await consumeProviderAttempt({
                  query: q,
                  kind,
                  ctx,
                  lifecycle,
                  shouldRecordToolCall: (block) =>
                    isSpawnToolName(block.name) && ctx.autoLogToolCalls !== false,
                  onTextDelta: (text) => {
                    controller.enqueue(encoder.encode(text));
                    resultText += text;
                  },
                  onAssistant: (msg) => {
                    if (
                      lifecycle.abortController.signal.aborted ||
                      msg.text_streamed ||
                      msg.parent_tool_use_id != null
                    )
                      return;
                    const text = extractAssistantText(msg);
                    if (text) {
                      controller.enqueue(encoder.encode(text));
                      resultText += text;
                    }
                  },
                  abortedWithoutTerminalMessage: `[${kind}] Agent SDK run aborted with no terminal result`,
                });
              };
              await withPreparedExecutionQuery(
                lifecycle,
                modelBinding,
                actualInput,
                promptText,
                callOptions,
                consumePreparedQuery,
                ctx.beforeProviderQuery,
                ctx,
              );

              const result: RunTaskResult = {
                task_run_id: lifecycle.taskRunId,
                text: resultText,
                finishReason: lifecycle.finishReason,
                usage: lifecycle.usage,
                cost_usd: lifecycle.costUsd,
                cost_basis: lifecycle.costBasis,
                cost_ref: lifecycle.costRef,
              };
              await lifecycle.finishSuccess(result);
              return result;
            } catch (error) {
              if (lifecycle.started) {
                await lifecycle.recordEstimatedUsage({
                  promptText: usagePromptText,
                  output: emptyStreamTextStats(),
                  priceOrigin: 'failure-estimate',
                });
                const boundError = bindAgentRunError({
                  error,
                  kind,
                  taskRunId: lifecycle.taskRunId,
                  aborted: lifecycle.aborted,
                  costUsd: lifecycle.costUsd,
                });
                const settled = await lifecycle.finishFailure(boundError);
                if (!settled) {
                  // Assistant bytes may already have reached a live reader. Error the
                  // stream so the protocol cannot complete cleanly while the durable
                  // attempt truth stays unsettled.
                  shouldClose = false;
                  if (!clientCancelled) controller.error(boundError);
                  return;
                }
              }
              if (clientCancelled) {
                shouldClose = false;
                return;
              }
              const message =
                error instanceof Error
                  ? `[streamTask] ${error.message}`
                  : '[streamTask] unknown error';
              controller.enqueue(encoder.encode(`\n\n${message}\n`));
            } finally {
              lifecycle.dispose();
              if (shouldClose && !clientCancelled) controller.close();
            }
          }),
        {
          signal: lifecycle.abortController.signal,
          outcome: (result) => (result ? 'success' : 'error'),
          content: ctx.laminarContent
            ? {
                input: ctx.laminarContent.input,
                output: (result) => (result ? ctx.laminarContent?.output?.(result) : undefined),
              }
            : undefined,
        },
      );
    },
    cancel() {
      clientCancelled = true;
      lifecycle.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}

function extractAssistantText(msg: SDKAssistantMessage): string {
  let out = '';
  const blocks = (msg.message.content ?? []) as ContentBlock[];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/**
 * YUK-266 (C1) — collecting variant of streamTask: streams root text deltas and
 * resolves the full RunTaskResult (text + task_run_id + usage + cost) that the
 * Copilot turn-persistence contract needs.
 *
 * GRACEFUL DEGRADE (red line): a stream error AFTER text was collected and durably
 * settled resolves with `partial: true`; a settlement failure rejects, so the
 * caller never persists model output against an unsettled attempt id.
 */
export interface StreamCollectResult extends RunTaskResult {
  /** Exact SDK success `result`; unlike `text`, excludes assistant preambles. */
  terminalText?: string;
  /** Set when the stream errored mid-flight; `text` is whatever was collected. */
  partial?: boolean;
  /** Present on a partial result — the underlying error message. */
  error?: string;
  /** Safe classification from this attempt's observed provider response. */
  failure?: { kind: 'provider_request_rejected'; httpStatus: 400 };
}

export async function streamTaskCollecting(
  kind: string,
  input: unknown,
  initialCtx: StreamTaskCtx,
  onDelta: (text: string) => void,
): Promise<StreamCollectResult> {
  const ctx = { ...initialCtx, learnerLocale: initialCtx.learnerLocale ?? getLearnerLocale() };
  return traceOperation(
    'task.run',
    { task_kind: kind },
    () => streamTaskCollectingImpl(kind, input, ctx, onDelta),
    {
      signal: ctx.signal,
      content: ctx.laminarContent,
      outcome: (result) => (result.partial ? 'error' : 'success'),
    },
  );
}

async function streamTaskCollectingImpl(
  kind: string,
  input: unknown,
  ctx: StreamTaskCtx,
  onDelta: (text: string) => void,
): Promise<StreamCollectResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  assertChatExecutionKind(kind);
  const budget = resolveTaskBudget(kind, ctx.budgetOverride);
  const modelBinding = ctx.modelBinding;
  const lifecycle = createRunLifecycle<StreamCollectResult>({
    db: ctx.db,
    kind,
    timeoutMs: budget.timeout,
    timeoutSource: budget.timeoutSource,
    abortController: ctx.lifecycleAbortController,
    override: ctx.override,
    modelBinding,
    parentTaskRunId: ctx.parentTaskRunId,
    providerSessionDeadlineAt: resolveProviderSessionDeadlineAt(ctx.providerSessionDeadlineAt),
    taskRunId: ctx.taskRunId,
    signal: ctx.signal,
    logScope: 'streamTaskCollecting',
    compiledPromptProvenance: compiledPromptProvenance(ctx.compiledModelPrompt),
    afterRun: ctx.middleware?.afterRun
      ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
      : undefined,
  });
  let resultText = '';
  let terminalText: string | undefined;
  let failure: StreamCollectResult['failure'];

  return lifecycle.withTracing(async () => {
    let usagePromptText = '';
    try {
      const actualInput = ctx.middleware?.beforeRun
        ? await ctx.middleware.beforeRun(kind, input, ctx)
        : input;
      const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
      usagePromptText = typeof promptText === 'string' ? promptText : '';
      const callOptions = buildQueryOptions(
        kind,
        ctx,
        lifecycle.abortController,
        lifecycle.resolved,
        budget,
        lifecycle.transportEvidence,
      );
      const consumePreparedQuery = async (q: AsyncIterable<RunnerMessage>) => {
        await consumeProviderAttempt({
          query: q,
          kind,
          ctx,
          lifecycle,
          notifySessionId: true,
          shouldRecordToolCall: (block) =>
            isSpawnToolName(block.name) && ctx.autoLogToolCalls !== false,
          onTextDelta: (text) => {
            onDelta(text);
            resultText += text;
          },
          onAssistant: (msg) => {
            if (
              lifecycle.abortController.signal.aborted ||
              msg.text_streamed ||
              msg.parent_tool_use_id != null
            )
              return;
            const text = extractAssistantText(msg);
            if (text) {
              onDelta(text);
              resultText += text;
            }
          },
          onSuccess: (msg) => {
            terminalText = msg.result;
          },
          onToolUse: ctx.onToolUse
            ? (block) => {
                ctx.onToolUse?.({
                  toolName: block.name,
                  input: (block.input ?? {}) as Record<string, unknown>,
                  toolUseId: block.id,
                });
              }
            : undefined,
          onApiError: (msg) => {
            console.warn('[streamTaskCollecting] task_run_success_with_error_flag', {
              event: 'task_run_success_with_error_flag',
              task_run_id: lifecycle.taskRunId,
              kind,
              api_error_status: msg.api_error_status ?? null,
            });
          },
          apiErrorMessages: (msg) => (msg.result ? [msg.result] : []),
          onResultError: (msg) => {
            if (
              msg.subtype === 'error_during_execution' &&
              msg.provider_request_rejection?.http_status === 400
            ) {
              failure = { kind: 'provider_request_rejected', httpStatus: 400 };
            }
          },
          abortedWithoutTerminalMessage: `[${kind}] Agent SDK run aborted with no terminal result`,
        });
      };
      await withPreparedExecutionQuery(
        lifecycle,
        modelBinding,
        actualInput,
        promptText,
        callOptions,
        consumePreparedQuery,
        ctx.beforeProviderQuery,
        ctx,
      );

      const result: StreamCollectResult = {
        task_run_id: lifecycle.taskRunId,
        text: resultText,
        ...(terminalText !== undefined ? { terminalText } : {}),
        finishReason: lifecycle.finishReason,
        usage: lifecycle.usage,
        cost_usd: lifecycle.costUsd,
        cost_basis: lifecycle.costBasis,
        cost_ref: lifecycle.costRef,
      };
      await lifecycle.finishSuccess(result);
      return result;
    } catch (error) {
      if (!lifecycle.started) throw error;
      await lifecycle.recordEstimatedUsage({
        promptText: usagePromptText,
        output: emptyStreamTextStats(),
        priceOrigin: 'failure-estimate',
      });
      const successSettlementFailed = error instanceof AttemptSettlementError;
      const boundError = bindAgentRunError({
        error,
        kind,
        taskRunId: lifecycle.taskRunId,
        aborted: lifecycle.aborted,
        costUsd: lifecycle.costUsd,
      });
      const settled = await lifecycle.finishFailure(boundError);
      // A provider-success payload whose projection failed must never be returned
      // as graceful partial text; admission fencing is likewise a fail-closed
      // verdict, not a stream failure Copilot may present as a partial reply.
      if (!settled || successSettlementFailed || boundError.subtype === 'provider_admission') {
        throw boundError;
      }
      return {
        task_run_id: lifecycle.taskRunId,
        text: resultText,
        finishReason: 'error',
        usage: lifecycle.usage,
        cost_usd: lifecycle.costUsd,
        cost_basis: lifecycle.costBasis,
        cost_ref: lifecycle.costRef,
        partial: true,
        error: error instanceof Error ? error.message : String(error),
        ...(!lifecycle.aborted && failure ? { failure } : {}),
      };
    } finally {
      lifecycle.dispose();
    }
  });
}
