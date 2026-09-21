// AI task runner — pi execution lane.
//
// All paths go through the ExecutionAdapter seam (execution-adapter.ts), which
// post-P4 resolves to PiAgentAdapter: an in-process `@earendil-works/
// pi-agent-core` agentLoop per query. The adapter normalizes loop events into
// the SDKMessage-shaped RunnerMessage vocabulary (sdk-types.ts) so the consume
// loop keeps one implementation for:
//   - tool-call loop with declarative piToolMounts / allowedTools
//   - piHooks beforeToolCall / afterToolCall interception
//   - task_* lifecycle frames (durable subagent projection)
//   - compact_boundary evidence + native transformContext compaction
//   - `pi:` session cursors + durable-turn replay (session resume)
//
// Provider wire protocols are the adapter's business (anthropic-messages for
// xiaomi/zhipu/anthropic/anthropic-sub, openai-* for opencode-go); the runner
// only ever sees normalized frames.
//
// Memory-layer extensibility:
//   - `RunTaskCtx.middleware: { beforeRun, afterRun }` — pre/post hooks
//     applied uniformly across runTask / runAgentTask / streamTask.
//     Memory module decorates input ahead of the model call and observes
//     output after.

import { createHash } from 'node:crypto';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import { type TaskKind, tasks } from '@/ai/registry';
import { getTaskSystemPrompt } from '@/ai/task-prompts';
import type { TaskDefinition } from '@/ai/task-spec';
import type { Db } from '@/db/client';
import type { SubjectProfile } from '@/subjects/profile';
import { resolveProviderSessionDeadlineAt } from '../http/provider-session-deadline';
import type { R2Client } from '../r2';
import {
  AgentRunError,
  RETRY_ELAPSED_CAP_MS,
  bindAgentRunError,
  isApiErrorSuccessResult,
} from './agent-run-error';
import {
  type ModelBinding,
  type PiQueueSources,
  type PiReplayTurn,
  type PreparedExecutionQuery,
  type RunnerMessage,
  resolveExecutionAdapter,
} from './execution-adapter';
import { logMissingToolMountsWarning } from './log';
import type { PiHookBridge } from './pi-hooks';
import { PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS } from './provider-session-admission';
import type { ResolvedProvider } from './providers';
import {
  type AiRunLifecycle,
  AttemptSettlementError,
  type LifecycleUsage,
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
import { isSpawnToolName } from './spawn-contract';
import type { PiSubagentSpec } from './tools/pi-subagent';
import type { PiToolMount } from './tools/pi-tools';

// ============================================================================
// Public surface
// ============================================================================

export interface RunTaskResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: LifecycleUsage;
  /** Known USD amount; absent when this attempt has no trustworthy price. */
  cost_usd?: number;
  /** Evidence class and immutable reference for cost_usd. */
  cost_basis: 'reported' | 'estimated' | 'unknown';
  cost_ref: string;
  /**
   * YUK-299 seam: the structured product an adapter fills in when a
   * structured-output protocol is honoured. Post-P4 the pi lane has no
   * outputFormat equivalent — this stays `undefined` and every caller runs
   * its strict-prompt + Zod text-fallback parse (already the production path
   * on the default mimo lane, YUK-792). Runner never interprets it.
   */
  structured_output?: unknown;
}

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
  db: Db;
  /** Caller-owned cancellation propagated into the SDK run lifecycle. */
  signal?: AbortSignal;
  /**
   * Stable controller shared with an in-process MCP ToolContext. The runner
   * owns its lifecycle semantics and aborts it on timeout/fencing/caller stop,
   * so a nested central task sees the exact parent-attempt cancellation signal.
   */
  lifecycleAbortController?: AbortController;
  /** Only vision/ingestion paths use this; runTask itself doesn't dereference. */
  r2?: R2Client;
  /** Override provider/model for testing or per-call routing escapes. */
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  /**
   * YUK-921 / YUK-1013 — per-run model binding (design doc §2.4/§4). The
   * explicit-ctx layer for per-run provider/model/effort selection; resolved
   * inside the unchanged `explicit > env > registry` order — `ctx.override`
   * (escape hatch) still wins per-field over this binding. Post-P4 the only
   * legal `adapter` value is 'pi'.
   */
  modelBinding?: ModelBinding;
  /**
   * YUK-576 — in-process transient-retry opt-in. Default OFF (undefined):
   * existing callers still make one loom-level attempt. ONLY call paths with NO durable
   * backstop may set this (single-transient-layer principle) — today exactly
   * the two vision judges (steps-judge.ts / multimodal-direct-judge.ts), whose
   * catch swallows failures into 'unsupported' so pg-boss never sees a throw.
   * Durable pg-boss handlers must NOT set it: queue redelivery (queue-config.ts
   * retryLimit) is their single transient layer — stacking both would multiply
   * worst-case paid calls (2×3). Enforced by src/server/ai/retry-optin.test.ts
   * (grep-level pin). Even when set, retry only fires when routing is not
   * pinned (no ctx.override, no ctx.modelBinding routing, no
   * AI_PROVIDER_OVERRIDE), the failure is
   * whitelist-transient (agent-run-error.ts §2.3 frozen table), the attempt
   * budget (tasks[kind].budget.transientRetries) has room, and the failure
   * arrived within RETRY_ELAPSED_CAP_MS of the first attempt (sync-route
   * wall-clock bound).
   */
  enableTransientRetry?: boolean;
  /**
   * Optional absolute wall-clock deadline for the whole provider session:
   * admission wait, adapter startup and model execution share this one budget.
   * Hono requests inherit the composition-root deadline automatically; callers
   * use this explicit seam for work that may outlive the handler. Durable workers
   * omit it and retain the task's full execution budget.
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
  /**
   * ADR-0060 compaction: the bounded session context the adapter's
   * transformContext re-injects after a budget prune. Never contains raw
   * summary/CoT. Enabled only for the Copilot live-session lane.
   */
  nativeCompaction?: {
    /** Context to reintroduce after compaction; never contains raw summary/CoT. */
    sessionContext: string;
  };
  /**
   * YUK-757 structural task-lifecycle observer. Only system task_started /
   * task_progress / task_updated / task_notification frames are exposed; raw
   * messages, assistant text, and thinking blocks never cross this seam.
   * Observer failures are logged and fail open so visibility cannot abort paid work.
   */
  onTaskEvent?: TaskEventObserver;
  /**
   * YUK-457 — streaming tool-use observer. Called synchronously for each
   * tool_use block in an assistant message during streamTaskCollecting. Receives
   * the sanitized call surface (tool name + serializable input); raw SDK internals
   * never cross this seam. Only fires during streaming; runTask/runAgentTask omit it.
   * Failures are swallowed so visibility cannot abort paid work.
   */
  onToolUse?: (call: {
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  }) => void;
  /**
   * YUK-575 (N5/MF-A) seam: per-call budget override for the durable copilot run.
   * The inline `CopilotTask` registry budget (maxIterations:6 / timeout:60_000) is
   * the model-execution share of the retained sync path; the Hono composition
   * root's absolute provider-session deadline keeps admission + startup + execution
   * below cloudflared idle-100s. A durable pg-boss run needs a much larger
   * ceiling but MUST NOT mutate the shared registry default (YUK-458 revert lesson:
   * a raised inline budget only turned error_max_turns into an inline-request abort).
   * NARROW: only `maxIterations` (→ SDK maxTurns) and `timeoutMs` (→ the abort timer).
   * The THIRD durable knob — the tool-call ceiling (maxToolCalls) — is NOT here: it
   * lives in the ContextBudgetTracker (budgets.ts, surface-keyed) and is overridden
   * at the handler when constructing the tracker (MF-A). OMITTED (the default) ⇒
   * buildQueryOptions / the runTask and collecting lifecycle timers read
   * `def.budget` verbatim ⇒
   * byte-identical to pre-seam (zero regression); only the copilot_run handler sets
   * it. It is consumed into maxTurns / the timer and is never an Options key.
   */
  budgetOverride?: { maxIterations?: number; timeoutMs?: number };
  /**
   * Optional caller-owned correlation id shared with an in-process MCP server.
   * Omitted callers keep runner-generated ids. `runTask` uses it for the first
   * attempt; any opt-in transient retry gets a fresh id to preserve row identity.
   */
  taskRunId?: string;
  /** Runs after durable attempt creation and immediately before WarmQuery.query submits a prompt. */
  beforeProviderQuery?: BeforeProviderQuery;
  /**
   * Active outer central attempt for a nested DomainTool run. Same-lane children
   * borrow the parent's session-concurrency slot so maxConcurrency=1 cannot
   * deadlock outer query → tool → inner query. The DB validates the parent lease.
   */
  parentTaskRunId?: string;
  /**
   * Disable runner-owned tool logging. `runTask` records only the SDK-native Task
   * spawn; MCP DomainTools keep their bridge-owned authoritative input/output row.
   * Streaming runners retain their existing input-only logging contract.
   */
  autoLogToolCalls?: boolean;
  /**
   * YUK-936 (ADR-0054) — the durable agent-session slot (historical name: it
   * held the SDK session-file id; post-P4 it carries the `pi:` cursor minted
   * by the adapter). `persist` keeps the cursor for resume; `resume` replays
   * `ctx.piSessionReplay` into the loop context; `onSessionId` observes the
   * minted id. Set explicitly by chat.ts; never inferred from task kind.
   * Omitted ⇒ no resume, no id subscription.
   */
  sdkSession?: {
    persist: boolean;
    resume?: string;
    onSessionId?: (sessionId: string) => void | Promise<void>;
  };
  compiledModelPrompt?: CompiledModelPrompt;
  /**
   * YUK-921 P2 (YUK-1021) — THE tool mount surface (post-P4 the only one).
   * Domain tools via piDomainMount, remote MCP via piRemoteMcpMount, bespoke
   * tools via a custom AgentTool mount. needsToolCall kinds must mount at
   * least one visible tool — the adapter fails closed otherwise.
   */
  piToolMounts?: PiToolMount[];
  /**
   * YUK-1022 — THE tool-call interception surface (post-P4 the only one):
   * ordered beforeToolCall gates + afterToolCall observers (spawn-contract
   * gate, cancellation, finalization trace).
   */
  piHooks?: PiHookBridge;
  /** Replay turns seeded into `context.messages` when `sdkSession.resume` is set. */
  piSessionReplay?: readonly PiReplayTurn[];
  /** Resolved skill bodies appended to the pi system prompt. */
  piSkillDocs?: readonly { name: string; body: string }[];
  /** Depth-one nested-agent specs; mounts the `Task`/`Agent` AgentTool. */
  piAgents?: Record<string, PiSubagentSpec>;
  /**
   * YUK-1022 — steering/follow-up queue sources for the root pi loop. No
   * caller provides one today; the ctx surface is wired so attaching queue
   * semantics later needs no adapter surgery.
   */
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
    /** base64-encoded image data (no "data:" prefix), URL, or Buffer-like. */
    data: string | URL | Uint8Array;
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
  if (data instanceof URL) return data.toString();
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
            return {
              type: 'image' as const,
              source: { type: 'url' as const, url: data },
            };
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
 * Build the per-attempt call spec for the pi adapter. Centralised so the 3
 * entry points (runTask / runAgentTask / streamTask) stay consistent on
 * tools-from-registry default, turn ceiling, session resume, etc.
 *
 * Post-P4 surface (vendored `Options` in sdk-types.ts): model / systemPrompt /
 * abort / tool allowlist / turn ceiling / effort / resume.
 * The SDK-only knobs (env, cwd, permissionMode, hooks, agents, skills,
 * settingSources, outputFormat, maxBudgetUsd, persistSession, title) died with
 * Adapter A — their pi equivalents live on `ctx.pi*` fields the adapter reads
 * directly, not on this call spec.
 */
function buildQueryOptions(
  kind: TaskKind,
  ctx: RunTaskCtx,
  abortController: AbortController,
  // The caller resolves ONCE per attempt and threads the binding in (YUK-576):
  // single resolution per attempt keeps the retry loop's env/model provably
  // per-attempt-consistent.
  resolved: ResolvedProvider,
): Options {
  // The registry map's value type is the union of every spec's inferred literal
  // shape. Optional fields (reasoningEffort) only exist on declaring members, so
  // they are read through this declared-interface view; the literal union stays
  // the source for mutable-array fields like allowedTools.
  const def = tasks[kind];
  const declaredDef: TaskDefinition = def;
  const options: Options = {
    model: resolved.model,
    systemPrompt: getTaskSystemPrompt(kind, ctx.subjectProfile),
    abortController,
    tools: ctx.allowedTools ?? def.allowedTools,
    // YUK-575 (N5) — durable copilot run overrides the turn ceiling per-call.
    maxTurns: (ctx.budgetOverride?.maxIterations ?? def.budget.maxIterations) || 1,
  };
  // YUK-923 — reasoning effort tier: per-run modelBinding wins over the
  // task-kind declaration; unset → the provider default applies.
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
 * Start the adapter-resolved transport inside admission without sending a
 * prompt, then create the durable attempt/timer immediately before the one
 * allowed query. Cleanup remains part of the admitted session boundary.
 * YUK-1013 — the ExecutionAdapter seam: `adapter.startup` replaces the direct
 * `sdkStartup` call; Adapter A wraps the identical WarmQuery lifecycle, so
 * every entry point keeps byte-identical behaviour while a second engine
 * (pi agentLoop, P1) can plug in behind the same three hooks.
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
  // Resolved at the seam boundary so an unimplemented adapter pin throws the
  // same config-error posture as resolveTaskProvider's credential checks —
  // before admission, before any durable row.
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
        // YUK-1022 — pi-lane dual descriptors for the P3 surfaces (hooks,
        // session replay, skill bodies, nested agents). The SDK adapter
        // ignores them; `nativeCompaction` is forwarded verbatim because the
        // pi lane needs the raw sessionContext for transformContext.
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
 * Consume one prepared SDK query while keeping caller-owned lifecycle policy at
 * the entrypoint. This is deliberately only the shared message-iteration and
 * terminal core: retry, settlement, stream cancellation, and partial-result
 * behavior remain with runTask/streamTask/streamTaskCollecting.
 */
async function consumeProviderAttempt<TResult extends RunTaskResult>(args: {
  query: AsyncIterable<RunnerMessage>;
  kind: TaskKind;
  ctx: RunTaskCtx;
  lifecycle: AiRunLifecycle<TResult>;
  notifySessionId?: boolean;
  shouldRecordToolCall: (block: SDKToolUseBlock) => boolean;
  onAssistant?: (msg: SDKAssistantMessage) => Promise<void> | void;
  onToolUse?: (block: SDKToolUseBlock) => void;
  onSuccess?: (msg: SDKSuccessResultMessage) => Promise<void> | void;
  onApiError?: (msg: SDKSuccessResultMessage) => void;
  apiErrorMessages?: (msg: SDKSuccessResultMessage) => string[];
  onResultError?: (msg: Exclude<SDKResultMessage, SDKSuccessResultMessage>) => void;
  abortedWithoutTerminalMessage: string;
}): Promise<void> {
  const terminal = createSdkTerminalEvidenceCollector();
  let iteration = 0;
  let stepStartTime = Date.now();

  for await (const msg of args.query) {
    if (args.notifySessionId && msg.type === 'system' && msg.subtype === 'init') {
      await notifySdkSessionId(args.ctx, msg);
    }
    await notifyTaskEvent(args.ctx, msg);

    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      args.lifecycle.recordObservedUsage(terminal.observeCompaction(msg));
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

  if (!args.lifecycle.sawTerminalResult) {
    if (args.lifecycle.aborted) {
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

// ============================================================================
// runTask — default path. Goes through the Claude Agent SDK like the other
// entry points; tasks without `allowedTools` declared in registry just get
// an empty tool list and behave like a single-turn query.
// ============================================================================

/**
 * YUK-576 — should this call participate in the in-process transient-retry
 * loop? Gate order (design doc §3.2): call-site opt-in (default OFF, so every
 * non-opt-in caller keeps one loom-level attempt) → caller-pinned routing OFF → env-pinned
 * routing OFF (pinned routing is an explicit decision — e.g. induce.ts pins
 * anthropic-sub per call for self-consistency sampling, where a silent retry
 * would still be same-target but the pin marks a lane where wall-clock
 * determinism matters more than absorption).
 */
async function runTaskAttempt(args: {
  kind: TaskKind;
  actualInput: unknown;
  ctx: RunTaskCtx;
  lifecycle: AiRunLifecycle<RunTaskResult>;
  /** Effective binding after the env rollout pin — resolved once by the caller. */
  modelBinding: RunTaskCtx['modelBinding'];
  onProviderQueryStarted?: () => Promise<void>;
  warnMissingMcp?: boolean;
}): Promise<RunTaskResult> {
  const { kind, actualInput, ctx, lifecycle, modelBinding } = args;

  let resultText = '';
  // Purely local preparation can perform cold-start filesystem work (notably
  // the one-time isolated skill mirror). Keep it outside the distributed
  // lease: blocking this event loop after acquire can delay the first
  // heartbeat beyond its DB-derived deadline even though no provider work has
  // started yet.
  const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
  const callOptions = buildQueryOptions(kind, ctx, lifecycle.abortController, lifecycle.resolved);
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
  };
  await lifecycle.finishSuccess(result);
  return result;
}

export async function runTask(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];

  // beforeRun runs exactly once, OUTSIDE the attempt loop — every attempt sees
  // the same transformed input and therefore the same input_hash.
  const actualInput = ctx.middleware?.beforeRun
    ? await ctx.middleware.beforeRun(kind, input, ctx)
    : input;

  const modelBinding = ctx.modelBinding;
  // Narrow pass, not {...ctx}: RunTaskCtx consumers may define lazy getters
  // (allowedTools et al.) whose evaluation must stay single-shot and ordered.
  const maxAttempts = maxLifecycleAttempts(kind, {
    enableTransientRetry: ctx.enableTransientRetry,
    override: ctx.override,
    modelBinding,
  });
  const firstAttemptStartedAt = Date.now();
  const retryingSyncDeadlineAt =
    maxAttempts > 1 ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS + def.budget.timeout : undefined;
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
      timeoutMs: ctx.budgetOverride?.timeoutMs ?? def.budget.timeout,
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
      return await runTaskAttempt({
        kind,
        actualInput,
        ctx,
        lifecycle,
        modelBinding,
        // needsToolCall with no pi-visible mounts runs tool-less — warn once.
        warnMissingMcp: attempt === 1 && def.needsToolCall && !ctx.piToolMounts?.length,
        onProviderQueryStarted: retrySource
          ? async () => {
              await retrySource?.markRetried();
              retrySource = undefined;
            }
          : undefined,
      });
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
      // after the next WarmQuery has actually submitted its prompt.
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

// ============================================================================
// runAgentTask — alias kept so callers that explicitly want the
// "I'm doing a tool-call loop, here's my MCP server" form can phrase intent.
// Behaviour is identical to runTask — pass ctx.piToolMounts / ctx.allowedTools
// or let the registry's `allowedTools` apply.
// ============================================================================

export async function runAgentTask(
  kind: string,
  input: unknown,
  ctx: RunAgentTaskCtx,
): Promise<RunTaskResult> {
  return runTask(kind, input, ctx);
}

// ============================================================================
// streamTask — text-stream Response. Same pi path; pipes assistant text
// deltas to the body. Tool-use blocks land in tool_call_log per turn.
// ============================================================================

export function streamTask(kind: string, input: unknown, ctx: StreamTaskCtx): Response {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const modelBinding = ctx.modelBinding;
  const lifecycle = createRunLifecycle<RunTaskResult>({
    db: ctx.db,
    kind,
    timeoutMs: def.budget.timeout,
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
      const encoder = new TextEncoder();
      let resultText = '';
      let shouldClose = true;

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
        );
        const consumePreparedQuery = async (q: AsyncIterable<RunnerMessage>) => {
          await consumeProviderAttempt({
            query: q,
            kind,
            ctx,
            lifecycle,
            shouldRecordToolCall: () => ctx.autoLogToolCalls !== false,
            onAssistant: (msg) => {
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
      } catch (error) {
        if (lifecycle.started) {
          const boundError = bindAgentRunError({
            error,
            kind,
            taskRunId: lifecycle.taskRunId,
            aborted: lifecycle.aborted,
          });
          const settled = await lifecycle.finishFailure(boundError);
          if (!settled) {
            // Assistant bytes may already have reached a live reader and cannot be
            // retracted. Error the stream so the protocol cannot still complete
            // cleanly while its durable attempt truth remains unsettled.
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
          error instanceof Error ? `[streamTask] ${error.message}` : '[streamTask] unknown error';
        controller.enqueue(encoder.encode(`\n\n${message}\n`));
      } finally {
        lifecycle.dispose();
        if (shouldClose && !clientCancelled) controller.close();
      }
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

// ============================================================================
// streamTaskCollecting — YUK-266 (C1). A collecting variant of streamTask:
// streams text deltas to an `onDelta(chunk)` callback (one call per
// assistant-message text chunk — the same honest per-model-turn granularity
// streamTask uses, since buildQueryOptions does NOT set includePartialMessages),
// then RESOLVES the full RunTaskResult (text + task_run_id + usage + cost). Unlike
// streamTask (which returns a text-only Response and discards the final metadata),
// the Copilot S3a turn-persistence contract needs the full reply text AND the real
// task_run_id to persist the experimental:copilot_reply event — so this entrypoint
// hands both back to the caller while still streaming.
//
// SDK message adaptation remains local, while run start/provider/abort/tool-log/
// cost/terminal/after-run ownership is shared through run-lifecycle.ts.
//
// GRACEFUL DEGRADE (red line): if the SDK stream throws AFTER some text was
// collected and the failure truth settles durably, this resolves with the collected
// text + a `partial: true` flag (mirroring streamTask's catch that appends an error
// marker but still finishes). A terminal-settlement failure rejects instead: the
// caller must never persist partial model output against an unsettled attempt id.
export interface StreamCollectResult extends RunTaskResult {
  /** Exact SDK success `result`; unlike `text`, excludes assistant preambles. */
  terminalText?: string;
  /** Set when the stream errored mid-flight; `text` is whatever was collected. */
  partial?: boolean;
  /** Present on a partial result — the underlying error message. */
  error?: string;
}

export async function streamTaskCollecting(
  kind: string,
  input: unknown,
  ctx: StreamTaskCtx,
  onDelta: (text: string) => void,
): Promise<StreamCollectResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const modelBinding = ctx.modelBinding;
  const lifecycle = createRunLifecycle<StreamCollectResult>({
    db: ctx.db,
    kind,
    timeoutMs: ctx.budgetOverride?.timeoutMs ?? def.budget.timeout,
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

  try {
    const actualInput = ctx.middleware?.beforeRun
      ? await ctx.middleware.beforeRun(kind, input, ctx)
      : input;
    const promptText = ctx.compiledModelPrompt?.text ?? promptFromInput(actualInput);
    const callOptions = buildQueryOptions(kind, ctx, lifecycle.abortController, lifecycle.resolved);
    const consumePreparedQuery = async (q: AsyncIterable<RunnerMessage>) => {
      await consumeProviderAttempt({
        query: q,
        kind,
        ctx,
        lifecycle,
        notifySessionId: true,
        shouldRecordToolCall: () => ctx.autoLogToolCalls !== false,
        onAssistant: (msg) => {
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
    const successSettlementFailed = error instanceof AttemptSettlementError;
    const boundError = bindAgentRunError({
      error,
      kind,
      taskRunId: lifecycle.taskRunId,
      aborted: lifecycle.aborted,
    });
    const settled = await lifecycle.finishFailure(boundError);
    // A provider-success payload whose success projection failed must never be
    // returned as graceful partial text, even if the bounded fallback records
    // the application attempt as failure successfully. Admission fencing is
    // likewise a fail-closed control-plane verdict, not an SDK stream failure
    // that Copilot may persist and present as a graceful partial reply.
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
    };
  } finally {
    lifecycle.dispose();
  }
}
