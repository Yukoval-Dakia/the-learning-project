// YUK-921 — ExecutionAdapter seam. P4 (YUK-1025) retired Adapter A: the Claude
// Agent SDK subprocess is gone and PiAgentAdapter is the only execution path.
// The seam stays deliberately — `PreparedExecutionQuery` (startup inside
// admission, one prompt submission, close-order ownership) is the contract the
// durable lifecycle supervises, regardless of engine.
//
// Frame vocabulary: the consume loop (lifecycle / terminal evidence /
// tool_call recording / durable task_* projection) still reads SDKMessage-
// shaped frames. Those are OUR protocol types now — `sdk-types.ts` holds the
// fresh declarations the pi adapter produces; no @anthropic-ai/claude-agent-sdk
// import remains.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { TaskKind } from '@/ai/registry';
import type { EffortLevel } from '@/ai/task-spec';
import { PiAgentAdapter } from './pi-agent-adapter';
import type { PiHookBridge } from './pi-hooks';
import type { ResolvedProvider } from './providers';
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from './sdk-types';
import type { PiSubagentSpec } from './tools/pi-subagent';
import type { PiToolMount } from './tools/pi-tools';

/** Post-P4 the only engine id; the field stays so a future adapter has a home. */
export type ExecutionAdapterId = 'pi';

/**
 * Per-run model binding (design doc §2.4 / §4). This is the explicit-ctx
 * layer for per-run provider/model/effort selection — the durable surface
 * YUK-1007's config panel reads/writes. `ctx.override` stays the test/dev
 * escape hatch and still wins per-field over modelBinding when both are set
 * (see explicitProviderRouting).
 */
export interface ModelBinding {
  /** Provider id from the providers.ts registry. */
  provider?: ResolvedProvider['provider'];
  /** Model id inside the resolved provider's catalog. */
  model?: string;
  /** Reasoning effort tier — same EffortLevel the task spec declares; explicit binding wins. */
  effort?: EffortLevel;
  /**
   * Execution engine pin. Post-P4 only 'pi' is legal; any other runtime value
   * (stale config rows, stale callers) fails closed in resolveExecutionAdapter.
   */
  adapter?: ExecutionAdapterId;
}

/**
 * Pi-adapter runner frames (YUK-921 P1). The pi agentLoop's events are
 * normalized into SDKMessage-shaped frames at the adapter boundary so the
 * consume loop (lifecycle/terminal/tool_call recording) stays a single
 * implementation; `source: 'pi'` declares provenance instead of faking
 * SDK-only metadata. Intersections stay structurally assignable to their SDK
 * member, so `runner-terminal` and `isTaskEventMessage` consume them
 * unchanged.
 */
export type PiRunnerMessage =
  | (SDKAssistantMessage & { source: 'pi' })
  | (SDKResultMessage & { source: 'pi' })
  | (SDKUserMessage & { source: 'pi' })
  | (Extract<SDKMessage, { type: 'system' }> & { source: 'pi' });

/**
 * Engine-neutral replay turn for `piSessionReplay` (YUK-1022). The caller
 * projects durable conversation rows (role + bounded text); the adapter owns
 * the AgentMessage construction because assistant messages need the resolved
 * model's api/provider envelope. 'context' entries (e.g. the pinned
 * learner-state header) map to user-role messages — the same position they
 * occupy inside the cold-start prompt envelope.
 */
export interface PiReplayTurn {
  role: 'user' | 'assistant' | 'context';
  text: string;
}

/**
 * Pi queue sources for steering/follow-up messages (YUK-1022, spec §3 P3).
 * The pi loop polls `getSteeringMessages` mid-run (after a turn's tool calls,
 * before the next LLM call) and `getFollowUpMessages` when the agent would
 * otherwise stop. The surface is wired end-to-end on purpose even though no
 * caller provides one today — attaching queue semantics later must not
 * require adapter surgery.
 */
export interface PiQueueSources {
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

/**
 * Message union consumed by runner entry points: the pi-normalized frames,
 * plus bare SDKMessage so legacy fixtures/callers that construct unmarked
 * frames still typecheck.
 */
export type RunnerMessage = SDKMessage | PiRunnerMessage;

/**
 * A prepared query session: transport resolved (admission already held by the
 * caller), prompt not yet submitted. `close()` must release any remote-MCP
 * handles and abort the loop — the adapter owns that distinction.
 */
export interface PreparedExecutionQuery {
  query(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<RunnerMessage>;
  close(): Promise<void>;
}

/** Arguments the adapter's `startup` receives. */
export interface ExecutionAdapterStartupArgs {
  /** Call spec built by buildQueryOptions (model/systemPrompt/maxTurns/tools/effort/resume). */
  options: Options;
  initializeTimeoutMs: number;
  /**
   * The lifecycle-resolved provider binding — credential, provider id and
   * model for this attempt. The adapter maps it to the loom pi catalog
   * (pi-models.ts) and passes the per-request credential to streamSimple.
   */
  resolved: ResolvedProvider;
  /**
   * The durable run identity (`ai_task_run.id`). Injected as the
   * `x-opencode-session` header — stable per attempt, auditable.
   */
  runId: string;
  /** Registry kind — the adapter reads `needsToolCall` for its fail-closed tool-mount rule. */
  kind: TaskKind;
  /**
   * YUK-921 P2 — declarative tool mounts. needsToolCall kinds must mount at
   * least one pi-visible tool (piDomainMount / piRemoteMcpMount / custom
   * AgentTools) unless the caller explicitly passes an empty allowedTools
   * (tool-less turns, e.g. Copilot authoritativeReply).
   */
  piToolMounts?: PiToolMount[];
  /**
   * YUK-921 P3 — pi-side hook bridge: ordered beforeToolCall gates +
   * afterToolCall observers (spawn-contract gate, cancellation, finalization
   * trace). This is THE tool-call interception surface post-P4.
   */
  piHooks?: PiHookBridge;
  /**
   * YUK-921 P3 — local session replay. When `options.resume` is set the caller
   * assembles durable conversation turns into this engine-neutral shape and
   * the adapter seeds `context.messages` with them. `resume` set but no replay
   * fails closed.
   */
  piSessionReplay?: readonly PiReplayTurn[];
  /**
   * YUK-921 P3 — resolved skill bodies for system-prompt injection (the pi
   * equivalent of SDK Agent Skills): the caller resolves SKILL.md bodies and
   * the adapter appends them to the system prompt.
   */
  piSkillDocs?: readonly { name: string; body: string }[];
  /**
   * YUK-921 P3 — depth-one nested-agent specs (mapped from the shared spawn
   * contract's `agents`). The adapter mounts the `Task`/`Agent` AgentTool and
   * runs nested agentLoops in-process.
   */
  piAgents?: Record<string, PiSubagentSpec>;
  /**
   * YUK-1022 — steering/follow-up queue sources, forwarded to the root
   * agentLoop config (nested loops never see them — steering targets the
   * running turn, not a synchronous child execution). No caller provides one
   * today; the surface exists so a future consumer attaches without adapter
   * surgery.
   */
  piQueues?: PiQueueSources;
  /**
   * YUK-921 P3 — forwarded `ctx.nativeCompaction` verbatim. The adapter arms
   * `transformContext` (budget prune + bounded-context re-injection per
   * ADR-0060) when present.
   */
  nativeCompaction?: { sessionContext: string };
}

export interface ExecutionAdapter {
  readonly id: ExecutionAdapterId;
  /** Start the transport without submitting a prompt (tool mounts resolve here). */
  startup(args: ExecutionAdapterStartupArgs): Promise<PreparedExecutionQuery>;
}

const PI_ADAPTER = new PiAgentAdapter();

let piAdapterForTests: ExecutionAdapter | undefined;

/**
 * Test-only seam (YUK-1022): swap the pi adapter instance so durable-path
 * tests (copilot_run Stop/重投 matrix) can drive the REAL PiAgentAdapter
 * wiring — startup gates, frame normalization, abort semantics — with a
 * scripted agentLoop. The provider wire is the only fake. Always restore
 * with `__setPiAdapterForTests(undefined)` in a finally/afterEach.
 */
export function __setPiAdapterForTests(adapter: ExecutionAdapter | undefined): void {
  piAdapterForTests = adapter;
}

/**
 * Engine selection for one attempt. Post-P4 this is a fail-closed guard, not
 * a router: every provider resolves to the pi adapter; a stale non-'pi'
 * adapter pin (config rows, old callers) throws a config error instead of
 * silently degrading.
 */
export function resolveExecutionAdapter(
  binding: ModelBinding | undefined,
  resolved: ResolvedProvider,
  kind: TaskKind,
): ExecutionAdapter {
  const requested = binding?.adapter ?? 'pi';
  if (requested !== 'pi') {
    throw new Error(
      `ExecutionAdapter '${requested}' was retired in YUK-1025 — the Claude Agent SDK subprocess is gone and 'pi' is the only execution path (task kind '${kind}', provider '${resolved.provider}'). Remove the adapter pin.`,
    );
  }
  return piAdapterForTests ?? PI_ADAPTER;
}

/**
 * Effective explicit routing for provider resolution. `ctx.override` (the
 * documented test/dev escape hatch) wins per-field over `ctx.modelBinding`
 * (the per-run binding); both then sit above env/registry inside
 * resolveTaskProvider's unchanged `explicit > env > registry` order.
 * Returns undefined when neither layer names a field — callers pass it
 * straight into `override:` so resolution stays byte-identical.
 */
export function explicitProviderRouting(ctx: {
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  modelBinding?: ModelBinding;
}): { provider?: ResolvedProvider['provider']; model?: string } | undefined {
  const provider = ctx.override?.provider ?? ctx.modelBinding?.provider;
  const model = ctx.override?.model ?? ctx.modelBinding?.model;
  if (provider === undefined && model === undefined) return undefined;
  return { provider, model };
}
