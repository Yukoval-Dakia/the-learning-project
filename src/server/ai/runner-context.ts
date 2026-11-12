import type { PiToolMount } from '@/ai/pi-tool-mount';
import type { RunTaskResult } from '@/ai/task-result';
import type { TaskBudgetOverride } from '@/capabilities/task-registry';
import type { PiSubagentSpec } from '@/core/subagent-contract';
import type { PiHookBridge } from '@/core/tool-call-contract';
import type { Db } from '@/db/client';
import type { R2Client } from '@/kernel/object-storage';
import type { SubjectProfile } from '@/subjects/profile';
import type { ModelBinding, PiQueueSources, PiReplayTurn } from './execution-adapter';
import type { TraceContent } from './laminar-tracing';
import type { ResolvedProvider } from './providers';
import type {
  Options,
  SDKRequestRetryMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from './sdk-types';

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
  /**
   * The caller has judged that this run's content holds no learner material. Only takes
   * effect for tasks on the transcript whitelist.
   */
  laminarTranscript?: boolean;
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
   * YUK-1548 §5 — streamed tool-argument progress for progressive block
   * display. Carries identity + byte count + a bounded prefix only.
   */
  onToolArgsDelta?: (delta: {
    toolName: string;
    toolUseId: string;
    receivedBytes: number;
    argsPrefix: string;
  }) => void;
  /**
   * YUK-1765 — the model is sending reasoning. A signal only: the reasoning
   * text itself leaves solely through `onThinkingDelta`.
   */
  onThinking?: () => void;
  /**
   * YUK-1909 — one reasoning delta for a display-only lane. The text leaves the
   * runner only through this callback; consumers must not persist it into any
   * durable sink (job_events, turns, Laminar, Mem0).
   */
  onThinkingDelta?: (delta: { text: string; taskRunId: string }) => void;
  /** YUK-1909 — per-attempt settle of the reasoning lane, fired as the query ends. */
  onThinkingSettled?: (result: {
    taskRunId: string;
    thinking: 'streamed' | 'none';
  }) => Promise<void> | void;
  /**
   * One interrupted provider request is being resent inside the same attempt.
   * The dead request already streamed `discarded_text_chars` of text (and
   * `discarded_thinking_chars` of reasoning) through onDelta/onThinkingDelta;
   * the consumer retracts exactly that tail before the resend streams.
   */
  onRequestRetry?: (
    retry: SDKRequestRetryMessage & { task_run_id: string },
  ) => Promise<void> | void;
  /** Settled, no-effect Copilot attempt; emitted before the next attempt is prepared. */
  onProviderRetry?: (retry: {
    nextTaskRunId: string;
    delayMs: number;
    retry: number;
  }) => Promise<void> | void;
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
  /**
   * Server-bound durable conversation the run belongs to (copilot turns).
   * Owner-scoped tool mounts bind to it; the model never supplies it.
   */
  sessionId?: string;
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
