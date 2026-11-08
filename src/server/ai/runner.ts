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
import { createId } from '@paralleldrive/cuid2';
import { AgentRunError, RETRY_ELAPSED_CAP_MS } from '@/ai/agent-run-error';
import {
  type FailureDiagnostics,
  failureDiagnostics,
  failureDiagnosticsCarryEvidence,
  failureDiagnosticsFromLinks,
  hostnameFromUrl,
} from '@/ai/failure-diagnostics';
import {
  helpFinishReason,
  helpProviderFaultFromSdkResult,
  renderHelpExitMarkdown,
} from '@/ai/help-provider-fault';
import { type ProviderFailureInfo, classifyProviderFailure } from '@/ai/provider-failure';
import { installTaskOperationObserver } from '@/ai/task-observation';
import type { RunTaskResult } from '@/ai/task-result';
import { failureSpendChargeUsd } from '@/ai/task-result';
import type { TaskBudget, TaskDefinition } from '@/ai/task-spec';
import {
  type TaskKind,
  getLearnerLocale,
  resolveTaskBudget,
  tasks,
} from '@/capabilities/task-registry';
import { isSpawnToolName } from '@/core/subagent-contract';
import { resolveProviderSessionDeadlineAt } from '../http/provider-session-deadline';
import { bindAgentRunError, isApiErrorSuccessResult } from './agent-run-error';
import {
  type ModelBinding,
  type PreparedExecutionQuery,
  type RunnerMessage,
  resolveExecutionAdapter,
} from './execution-adapter';
import { traceMetadata, traceOperation } from './laminar-tracing';
import { taskMayExportTranscript } from './laminar-transcript';
import { logMissingToolMountsWarning } from './log';
import { PROVIDER_HTTP_TIMEOUT_MARGIN_MS } from './provider-http-timeout';
import { PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS } from './provider-session-admission-policy';
import {
  planProviderTransientRetry,
  providerTransientRetryPolicy,
  sleepMs,
} from './provider-transient-retry';
import {
  type AiRunLifecycle,
  AttemptSettlementError,
  classifyLifecycleRetry,
  createRunLifecycle,
  maxLifecycleAttempts,
} from './run-lifecycle';
import { buildQueryOptions, workspaceInjectedExecution } from './runner-startup';
import { createSdkTerminalEvidenceCollector } from './sdk-terminal';
import type { Options, SDKAssistantMessage, SDKMessage, SDKUserMessage } from './sdk-types';
import { currentTaskSpendScope, withinTaskSpendFrame } from './task-spend-scope';
import { addStreamText, emptyStreamTextStats, lazyTimeoutPrompt } from './timeout-usage';

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

export type {
  BeforeProviderQuery,
  CompiledModelPrompt,
  ProviderQueryStartContext,
  RunTaskCtx,
  TaskEventMessage,
  TaskEventObserver,
  TaskMiddleware,
} from './runner-context';

import type {
  BeforeProviderQuery,
  CompiledModelPrompt,
  RunTaskCtx,
  TaskEventMessage,
} from './runner-context';

export function compiledPromptProvenance(prompt?: CompiledModelPrompt) {
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

export function isKnownTask(k: string): k is TaskKind {
  return (TASK_KINDS as string[]).includes(k);
}

/**
 * YUK-1049 — typed-execution tasks (execution:'typed') are served ONLY by the
 * typed primitive runner; the chat façade cannot build a prompt for them
 * ({kind:'none'}). Fail closed at every chat entry instead of letting a
 * typed kind reach adapter startup / getTaskSystemPrompt.
 */
export function assertChatExecutionKind(kind: TaskKind): void {
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
  const workspace = workspaceInjectedExecution(ctx, lifecycle.kind, options);

  return lifecycle.withProviderSession(actualInput, {
    async prepare() {
      prepared = await adapter.startup({
        options: workspace.options,
        initializeTimeoutMs: lifecycle.providerPhaseTimeoutMs(
          PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS,
        ),
        resolved: lifecycle.resolved,
        runId: lifecycle.taskRunId,
        kind: lifecycle.kind,
        structuredSubmitInput: actualInput,
        executionWindowMs: lifecycle.providerPhaseTimeoutMs(
          options.providerTimeoutMs === undefined
            ? Number.POSITIVE_INFINITY
            : options.providerTimeoutMs - PROVIDER_HTTP_TIMEOUT_MARGIN_MS,
        ),
        piToolMounts: workspace.mounts,
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
      await currentTaskSpendScope()?.beforeQuery(lifecycle.taskRunId);
      await beforeProviderQuery?.({
        taskRunId: lifecycle.taskRunId,
        provider: lifecycle.resolved.provider,
        model: lifecycle.resolved.model,
      });
      try {
        return await consume(prepared.query(prompt));
      } catch (error) {
        // YUK-1878 — known-zero unbilled rejection vs fail-closed unknown.
        currentTaskSpendScope()?.charge(failureSpendChargeUsd(lifecycle.costTruth));
        throw error;
      }
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
  onToolArgsDelta?: (msg: {
    tool_name: string;
    tool_call_id: string;
    received_bytes: number;
    args_prefix: string;
  }) => void;
  onThinking?: () => void;
  onOutputObserved?: () => void;
  onSuccess?: (msg: SDKSuccessResultMessage) => Promise<void> | void;
  onApiError?: (msg: SDKSuccessResultMessage) => void;
  apiErrorMessages?: (msg: SDKSuccessResultMessage) => string[];
  onResultError?: (msg: Exclude<SDKResultMessage, SDKSuccessResultMessage>) => void;
  abortedWithoutTerminalMessage: string;
  /** Submitted prompt, read at settle time. */
  usagePrompt?: () => string;
}): Promise<void> {
  const terminal = createSdkTerminalEvidenceCollector();
  let iteration = 0;
  let stepStartTime = Date.now();
  const modelStarted = Date.now();
  let firstOutputAt: number | undefined;
  let firstTextAt: number | undefined;
  let firstThinkingAt: number | undefined;
  let thinkingObserved = false;
  let completeArtifact = false;
  const outputStats = emptyStreamTextStats();
  const settleUnobservedUsage = async () => {
    // YUK-1557 — a cut stream with no usage frame still submitted a prompt:
    // persist a bounded estimate, never a null cost. A reported frame wins.
    await args.lifecycle.recordEstimatedUsage({
      promptText: args.usagePrompt?.() ?? '',
      output: outputStats,
      priceOrigin: args.lifecycle.aborted ? 'timeout-estimate' : 'failure-estimate',
    });
  };

  try {
    for await (const msg of args.query) {
      if (
        ((msg.type === 'text_delta' || msg.type === 'thinking_delta') && msg.text.length > 0) ||
        (msg.type === 'assistant' &&
          msg.message.content?.some((block) => block.type === 'tool_use')) ||
        (msg.type === 'user' &&
          Array.isArray(msg.message.content) &&
          msg.message.content.some((block) => block.type === 'tool_result')) ||
        (msg.type === 'system' && msg.subtype === 'tool_args_progress')
      )
        args.onOutputObserved?.();
      if (msg.type === 'text_delta' || msg.type === 'thinking_delta') {
        if (msg.text) {
          addStreamText(outputStats, msg.text);
          const at = Date.now();
          firstOutputAt ??= at;
          if (msg.type === 'text_delta') firstTextAt ??= at;
          else firstThinkingAt ??= at;
        }
        if (msg.type === 'text_delta' && !args.lifecycle.abortController.signal.aborted) {
          await args.onTextDelta?.(msg.text);
        }
        if (msg.type === 'thinking_delta' && msg.text) {
          thinkingObserved = true;
          args.onThinking?.();
          try {
            args.ctx.onThinkingDelta?.({
              text: msg.text,
              taskRunId: args.lifecycle.taskRunId,
            });
          } catch {
            // Display observers must not abort the paid attempt.
          }
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
      if (msg.type === 'system' && msg.subtype === 'tool_args_progress') {
        try {
          args.onToolArgsDelta?.(msg);
        } catch {
          // Visibility failures must never abort paid work.
        }
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
        if (!isApiErrorSuccessResult(msg) && (msg.result ?? '').trim().length > 0) {
          completeArtifact = true;
        }
        if (isApiErrorSuccessResult(msg)) {
          args.onApiError?.(msg);
          const helpProviderFault = helpProviderFaultFromSdkResult(msg);
          throw new AgentRunError({
            kind: args.kind,
            taskRunId: args.lifecycle.taskRunId,
            subtype: 'api_error_result',
            apiErrorStatus: msg.api_error_status ?? null,
            errors: args.apiErrorMessages?.(msg) ?? [msg.result ?? ''],
            ...(helpProviderFault ? { helpProviderFault } : {}),
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
        const helpProviderFault = helpProviderFaultFromSdkResult(msg);
        throw new AgentRunError({
          kind: args.kind,
          taskRunId: args.lifecycle.taskRunId,
          subtype: msg.subtype,
          errors: 'errors' in msg && Array.isArray(msg.errors) ? msg.errors : [],
          ...(helpProviderFault ? { helpProviderFault } : {}),
          ...(msg.provider_failure ? { providerFailure: msg.provider_failure } : {}),
        });
      }
      break;
    }
  } catch (error) {
    await settleUnobservedUsage();
    throw error;
  } finally {
    const endedAt = Date.now();
    args.lifecycle.noteHelpProviderClock({
      endedAt,
      ...(firstOutputAt !== undefined ? { firstTokenAt: firstOutputAt } : {}),
      completeArtifact,
    });
    args.lifecycle.recordNotePhases({
      model_total_ms: endedAt - modelStarted,
      model_ttft_ms: firstTextAt === undefined ? null : firstTextAt - modelStarted,
      model_thinking_ttft_ms: firstThinkingAt === undefined ? null : firstThinkingAt - modelStarted,
      stream_ms: firstTextAt === undefined ? 0 : endedAt - firstTextAt,
    });
    try {
      await args.ctx.onThinkingSettled?.({
        taskRunId: args.lifecycle.taskRunId,
        thinking: thinkingObserved ? 'streamed' : 'none',
      });
    } catch {
      // Visibility callbacks must not mask the attempt's own outcome.
    }
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
  const usagePrompt = lazyTimeoutPrompt(
    callOptions.systemPrompt,
    promptText,
    ctx.piSkillDocs,
    () => lifecycle.transportEvidence.optionalDependencyUnavailable,
  );
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
  try {
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
  } catch (error) {
    await lifecycle.recordEstimatedUsage({
      promptText: usagePrompt(),
      output: emptyStreamTextStats(),
      priceOrigin: 'failure-estimate',
    });
    throw error;
  }

  // The provider permit is released before attempt settlement / afterRun. A DB
  // observation write must never occupy scarce upstream session capacity.
  const helpLatency = lifecycle.sealHelpLatency('success');
  const result: RunTaskResult = {
    task_run_id: lifecycle.taskRunId,
    text: resultText,
    finishReason: lifecycle.finishReason,
    usage: helpLatency ? { ...lifecycle.usage, help_latency: helpLatency } : lifecycle.usage,
    cost_usd: lifecycle.costUsd,
    cost_basis: lifecycle.costBasis,
    cost_ref: lifecycle.costRef,
    structured_output: lifecycle.structuredOutput,
    ...(lifecycle.usage.phases ? { phases: lifecycle.usage.phases } : {}),
    ...(helpLatency ? { help_latency: helpLatency } : {}),
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
    allowTranscript: taskMayExportTranscript(kind, ctx.laminarTranscript),
  });
}

async function runTaskImpl(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
  enteredSpendFrame = false,
): Promise<RunTaskResult> {
  if (currentTaskSpendScope() && !enteredSpendFrame)
    return withinTaskSpendFrame(() => runTaskImpl(kind, input, ctx, true));
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  assertChatExecutionKind(kind);
  const scopedAllowance = currentTaskSpendScope()?.remainingUsd();
  const budget = resolveTaskBudget(kind, {
    ...ctx.budgetOverride,
    ...(scopedAllowance === undefined
      ? {}
      : {
          maxCost: Math.min(resolveTaskBudget(kind, ctx.budgetOverride).maxCost, scopedAllowance),
        }),
  });
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
      const boundError = bindAgentRunError({
        error: err,
        kind,
        taskRunId: lifecycle.taskRunId,
        aborted: lifecycle.aborted,
        costUsd: lifecycle.costUsd,
        helpLatency: lifecycle.sealHelpLatency('failure'),
      });
      lastErr = boundError;
      const retry = classifyLifecycleRetry({
        attempt,
        maxAttempts,
        firstAttemptStartedAt,
        error: boundError,
        transport: lifecycle.armedTransport(),
        attemptCostTruth: lifecycle.costTruth,
        aborted: lifecycle.aborted,
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
  const ctx = {
    ...initialCtx,
    learnerLocale: initialCtx.learnerLocale ?? getLearnerLocale(),
  };
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  assertChatExecutionKind(kind);
  const scopedAllowance = currentTaskSpendScope()?.remainingUsd();
  const budget = resolveTaskBudget(kind, {
    ...ctx.budgetOverride,
    ...(scopedAllowance === undefined
      ? {}
      : {
          maxCost: Math.min(resolveTaskBudget(kind, ctx.budgetOverride).maxCost, scopedAllowance),
        }),
  });
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
            let readUsagePrompt: () => string = () => '';

            try {
              const actualInput = ctx.middleware?.beforeRun
                ? await ctx.middleware.beforeRun(kind, input, ctx)
                : input;
              const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
              const callOptions = buildQueryOptions(
                kind,
                ctx,
                lifecycle.abortController,
                lifecycle.resolved,
                budget,
                lifecycle.transportEvidence,
              );
              readUsagePrompt = lazyTimeoutPrompt(
                callOptions.systemPrompt,
                promptText,
                ctx.piSkillDocs,
                () => lifecycle.transportEvidence.optionalDependencyUnavailable,
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
                  usagePrompt: readUsagePrompt,
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
                  promptText: readUsagePrompt(),
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
              // Run id rides the marker so workers can read back the settled row.
              const message = `[streamTask] ${
                error instanceof Error ? error.message : 'unknown error'
              } (task_run_id=${lifecycle.taskRunId})`;
              controller.enqueue(encoder.encode(`\n\n${message}\n`));
            } finally {
              lifecycle.dispose();
              if (shouldClose && !clientCancelled) controller.close();
            }
          }),
        {
          signal: lifecycle.abortController.signal,
          outcome: (result) => (result ? 'success' : 'error'),
          allowTranscript: taskMayExportTranscript(kind, ctx.laminarTranscript),
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
  /** Whitelisted cause chain of the original stream error, for durable_failure. */
  failureDiagnostics?: FailureDiagnostics;
  /**
   * Safe classification of a proven provider failure, with the provider's
   * Retry-After when it sent one. Absent when no provider fault is proven.
   */
  providerFailure?: ProviderFailureInfo;
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
      allowTranscript: taskMayExportTranscript(kind, ctx.laminarTranscript),
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
  const scopedAllowance = currentTaskSpendScope()?.remainingUsd();
  const budget = resolveTaskBudget(kind, {
    ...ctx.budgetOverride,
    ...(scopedAllowance === undefined
      ? {}
      : {
          maxCost: Math.min(resolveTaskBudget(kind, ctx.budgetOverride).maxCost, scopedAllowance),
        }),
  });
  const policy = providerTransientRetryPolicy();
  const retryPolicy = {
    ...policy,
    maxRetries: Math.min(2, policy.maxRetries),
    maxWaitMs: Math.min(15_000, policy.maxWaitMs),
  };
  const retryBudget = { retries: 0, waitedMs: 0 };
  const deadlineAt = Math.min(
    Date.now() + budget.timeout,
    resolveProviderSessionDeadlineAt(ctx.providerSessionDeadlineAt) ?? Infinity,
  );
  let taskRunId = ctx.taskRunId;
  const actualInput = ctx.middleware?.beforeRun
    ? await ctx.middleware.beforeRun(kind, input, ctx)
    : input;
  for (;;) {
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
      providerSessionDeadlineAt:
        kind === 'CopilotTask'
          ? deadlineAt
          : resolveProviderSessionDeadlineAt(ctx.providerSessionDeadlineAt),
      taskRunId,
      signal: ctx.signal,
      logScope: 'streamTaskCollecting',
      compiledPromptProvenance: compiledPromptProvenance(ctx.compiledModelPrompt),
      afterRun: ctx.middleware?.afterRun
        ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
        : undefined,
    });
    let outputObserved = false;
    let resultText = '';
    let terminalText: string | undefined;
    let providerFailureEvidence:
      | { http_status?: number; retry_after_ms?: number; stream_error?: true }
      | undefined;

    const outcome = await lifecycle.withTracing(async () => {
      let readUsagePrompt: () => string = () => '';
      try {
        const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
        const callOptions = buildQueryOptions(
          kind,
          ctx,
          lifecycle.abortController,
          lifecycle.resolved,
          budget,
          lifecycle.transportEvidence,
        );
        if (kind === 'CopilotTask') callOptions.judgeRetryPolicy = 'none';
        readUsagePrompt = lazyTimeoutPrompt(
          callOptions.systemPrompt,
          promptText,
          ctx.piSkillDocs,
          () => lifecycle.transportEvidence.optionalDependencyUnavailable,
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
            onOutputObserved: () => {
              outputObserved = true;
            },
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
                outputObserved = true;
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
            onToolArgsDelta: ctx.onToolArgsDelta
              ? (msg) => {
                  ctx.onToolArgsDelta?.({
                    toolName: msg.tool_name,
                    toolUseId: msg.tool_call_id,
                    receivedBytes: msg.received_bytes,
                    argsPrefix: msg.args_prefix,
                  });
                }
              : undefined,
            onThinking: ctx.onThinking,
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
              if (msg.provider_failure !== undefined)
                providerFailureEvidence = msg.provider_failure;
            },
            abortedWithoutTerminalMessage: `[${kind}] Agent SDK run aborted with no terminal result`,
            usagePrompt: readUsagePrompt,
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
          promptText: readUsagePrompt(),
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
        const helpFault = !lifecycle.aborted ? boundError.helpProviderFault : undefined;
        if (helpFault && kind !== 'CopilotTask') lifecycle.noteExecutableHelp('deterministic_step');
        // An aborted/stopped run never claims a provider cause — our own armed
        // timer or a caller cancel is not provider evidence.
        const providerFailure = lifecycle.aborted
          ? undefined
          : classifyProviderFailure({
              subtype: boundError.subtype,
              apiErrorStatus: boundError.apiErrorStatus,
              httpStatus: providerFailureEvidence?.http_status,
              retryAfterMs: providerFailureEvidence?.retry_after_ms,
              errorEvidence: boundError.errors,
              streamErrorTerminal: providerFailureEvidence?.stream_error === true,
              transport: lifecycle.transportEvidence.snapshot(),
            });
        const settled = await lifecycle.finishFailure(boundError);
        // A provider-success payload whose projection failed must never be returned
        // as graceful partial text; admission fencing is likewise a fail-closed
        // verdict, not a stream failure Copilot may present as a partial reply.
        if (!settled || successSettlementFailed || boundError.subtype === 'provider_admission') {
          throw boundError;
        }
        const transport = lifecycle.transportEvidence.snapshot();
        // pi flattens a provider exception to its message, so the thrown error often
        // loses the wire cause; the transport collector captured it first. Prefer the
        // thrown chain when it still carries evidence (e.g. MCP 401 + hostname).
        const thrownDiagnostics = failureDiagnostics(error);
        const transportDiagnostics = failureDiagnosticsFromLinks(
          transport.last_failure?.error ?? transport.last_transport_error?.error,
          hostnameFromUrl('baseUrl' in lifecycle.resolved ? lifecycle.resolved.baseUrl : undefined),
        );
        const failureDiagnosticsForResult =
          failureDiagnosticsCarryEvidence(thrownDiagnostics) || transportDiagnostics === undefined
            ? thrownDiagnostics
            : transportDiagnostics;
        // Reject the policy's broader 5xx verdicts and any earlier accepted/unknown send.
        // A bound 429 alone cannot erase a successful turn hidden earlier in this loop.
        const noEffect =
          transport.requests_seen > 0 &&
          transport.requests_dropped === 0 &&
          transport.requests.length === transport.requests_seen &&
          transport.requests.every(
            (request) =>
              request.loop === 'root' &&
              !request.timeout_layer &&
              (request.send_state === 'not_sent' ||
                (request.send_state === 'response_received' && request.http_status === 429)),
          );
        const retry =
          kind === 'CopilotTask' &&
          !outputObserved &&
          !lifecycle.aborted &&
          noEffect &&
          lifecycle.costTruth.amountUsd === 0
            ? await planProviderTransientRetry({
                db: ctx.db,
                error: boundError,
                policy: retryPolicy,
                budget: retryBudget,
                deadlineAt,
              })
            : undefined;
        if (
          retry &&
          (retry.verdict.class === 'rate_limited' || retry.verdict.class === 'not_sent')
        ) {
          return {
            retryDelayMs: retry.delayMs,
            failedTaskRunId: lifecycle.taskRunId,
            error: boundError,
          };
        }
        // Quota / 502 / parse seal an exit the caller can publish without another
        // model turn; the proven category still rides providerFailure so the wire
        // can name it. Cancellation is not one.
        if (helpFault) {
          const exit = renderHelpExitMarkdown(helpFault, {
            retryAfterMs: providerFailure?.retry_after_ms,
          });
          const prose = resultText.trim();
          return {
            task_run_id: lifecycle.taskRunId,
            text: resultText,
            terminalText: prose.length > 0 ? `${prose}\n\n${exit}` : exit,
            finishReason: helpFinishReason(helpFault),
            usage: lifecycle.usage,
            cost_usd: lifecycle.costUsd,
            cost_basis: lifecycle.costBasis,
            cost_ref: lifecycle.costRef,
            partial: false,
            ...(providerFailure ? { providerFailure } : {}),
          };
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
          failureDiagnostics: failureDiagnosticsForResult,
          ...(providerFailure ? { providerFailure } : {}),
        };
      } finally {
        lifecycle.dispose();
      }
    });
    if (!('retryDelayMs' in outcome)) return outcome;
    const nextTaskRunId = createId();
    try {
      await ctx.onProviderRetry?.({
        nextTaskRunId,
        delayMs: outcome.retryDelayMs,
        retry: retryBudget.retries + 1,
      });
      await sleepMs(outcome.retryDelayMs, ctx.lifecycleAbortController?.signal ?? ctx.signal);
      if (ctx.signal?.aborted || ctx.lifecycleAbortController?.signal.aborted)
        throw new Error('cancelled during retry');
    } catch (error) {
      return {
        task_run_id: outcome.failedTaskRunId,
        text: '',
        finishReason: 'error',
        usage: lifecycle.usage,
        cost_usd: lifecycle.costUsd,
        cost_basis: lifecycle.costBasis,
        cost_ref: lifecycle.costRef,
        partial: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await lifecycle.markRetried();
    retryBudget.retries += 1;
    retryBudget.waitedMs += outcome.retryDelayMs;
    taskRunId = nextTaskRunId;
  }
}
