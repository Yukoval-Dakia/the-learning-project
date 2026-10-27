// YUK-921 — ExecutionAdapter seam. YUK-1025 retired the Claude Agent SDK
// subprocess; PiAgentAdapter is the only execution path. The seam stays because
// `PreparedExecutionQuery` (startup inside admission, one prompt submission,
// close-order ownership) is the contract the durable lifecycle supervises.
//
// The consume loop still reads SDKMessage-shaped frames — our protocol types now
// (sdk-types.ts), produced by the pi adapter.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiToolMount } from '@/ai/pi-tool-mount';
import type { EffortLevel } from '@/ai/task-spec';
import type { TaskKind } from '@/capabilities/task-registry';
import type { PiSubagentSpec } from '@/core/subagent-contract';
import type { PiHookBridge } from '@/core/tool-call-contract';
import { PiAgentAdapter } from './pi-agent-adapter';
import type { ResolvedProvider } from './providers';
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from './sdk-types';

/** The only engine id; the field stays so a future adapter has a home. */
export type ExecutionAdapterId = 'pi';

/**
 * Per-run model binding: the explicit-ctx layer for provider/model/effort. The
 * test/dev `ctx.override` still wins per-field (see explicitProviderRouting).
 */
export interface ModelBinding {
  /** Provider id from the providers.ts registry. */
  provider?: ResolvedProvider['provider'];
  /** Model id inside the resolved provider's catalog. */
  model?: string;
  /** Reasoning effort tier — same EffortLevel the task spec declares; explicit binding wins. */
  effort?: EffortLevel;
  /**
   * Execution engine pin. Only 'pi' is legal; any other runtime value fails closed
   * in resolveExecutionAdapter.
   */
  adapter?: ExecutionAdapterId;
}

/**
 * Pi-adapter runner frames. Pi events are normalized to SDKMessage shapes at the
 * adapter boundary so the consume loop stays one implementation; `source: 'pi'`
 * declares provenance instead of faking SDK-only metadata.
 */
export type PiRunnerMessage =
  | { type: 'text_delta'; text: string; session_id: string; source: 'pi' }
  | { type: 'thinking_delta'; text: string; session_id: string; source: 'pi' }
  | (SDKAssistantMessage & { source: 'pi' })
  | (SDKResultMessage & { source: 'pi' })
  | (SDKUserMessage & { source: 'pi' })
  | (Extract<SDKMessage, { type: 'system' }> & { source: 'pi' });

/**
 * Engine-neutral replay turn. The caller projects durable rows; the adapter owns
 * AgentMessage construction because assistant messages need the model envelope.
 * 'context' maps to a user-role message at the cold-start header's position.
 */
export interface PiReplayTurn {
  role: 'user' | 'assistant' | 'context';
  text: string;
}

/**
 * Steering/follow-up sources (YUK-1022). Wired end-to-end even though no caller
 * provides one today, so attaching queue semantics needs no adapter surgery.
 */
export interface PiQueueSources {
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

/** Message union consumed by runner entry points; bare SDKMessage keeps legacy
 *  fixtures/callers typechecking. */
export type RunnerMessage = SDKMessage | PiRunnerMessage;

/**
 * A prepared query session: transport resolved, prompt not yet submitted.
 * `close()` releases remote-MCP handles and aborts the loop.
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
   * Lifecycle-resolved provider binding for this attempt. The adapter maps it to
   * the pi catalog and passes the credential to streamSimple.
   */
  resolved: ResolvedProvider;
  /** Durable run identity, injected as the `x-opencode-session` header. */
  runId: string;
  /** Registry kind — the adapter reads `needsToolCall` for its tool-mount rule. */
  kind: TaskKind;
  /**
   * Declarative tool mounts. needsToolCall kinds must mount at least one
   * pi-visible tool unless the caller explicitly passes an empty allowedTools.
   */
  piToolMounts?: PiToolMount[];
  /** Ordered beforeToolCall gates + afterToolCall observers. */
  piHooks?: PiHookBridge;
  /**
   * Durable conversation turns; seeded into `context.messages`. `options.resume`
   * without replay fails closed.
   */
  piSessionReplay?: readonly PiReplayTurn[];
  /** Resolved SKILL.md bodies appended to the system prompt. */
  piSkillDocs?: readonly { name: string; body: string }[];
  /** Depth-one nested-agent specs; mounts the `Task`/`Agent` AgentTool. */
  piAgents?: Record<string, PiSubagentSpec>;
  /** Steering/follow-up sources, forwarded to the ROOT loop only. */
  piQueues?: PiQueueSources;
  /** Forwarded verbatim; arms `transformContext` compaction (ADR-0060). */
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
 * Test-only seam: swap the pi adapter so durable-path tests exercise the real
 * wiring with a scripted agentLoop. Always restore with `undefined` in a finally.
 */
export function __setPiAdapterForTests(adapter: ExecutionAdapter | undefined): void {
  piAdapterForTests = adapter;
}

/**
 * Fail-closed engine guard: a stale non-'pi' adapter pin throws a config error
 * instead of silently degrading.
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
 * Effective explicit routing: `ctx.override` (test/dev escape hatch) wins per
 * field over `ctx.modelBinding`; both sit above env/registry inside
 * resolveTaskProvider. Undefined when neither names a field.
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
