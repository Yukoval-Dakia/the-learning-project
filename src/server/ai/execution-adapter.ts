// YUK-921 / YUK-1013 P0 — ExecutionAdapter seam. The runner talks to an
// adapter for "produce a query handle from (options, prompt)" instead of
// touching the Claude Agent SDK startup path directly. Adapter A (`sdk`)
// wraps the existing WarmQuery lifecycle byte-for-byte; Adapter B (`pi`,
// @earendil-works/pi-agent-core agentLoop) lands in P1 behind the same seam.
// Zero behaviour change: resolveExecutionAdapter today always returns the
// SDK adapter and an explicit non-sdk pin fails closed with a config error.

import {
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type WarmQuery,
  startup as sdkStartup,
} from '@anthropic-ai/claude-agent-sdk';
import type { TaskKind } from '@/ai/registry';
import type { EffortLevel } from '@/ai/task-spec';
import { PiAgentAdapter } from './pi-agent-adapter';
import { PI_LANE_PROVIDERS, type ResolvedProvider, isPiLaneProvider } from './providers';
import type { PiToolMount } from './tools/pi-tools';

export type ExecutionAdapterId = 'sdk' | 'pi';

/**
 * Per-run model binding (design doc §2.4 / §4). This is the NEW explicit-ctx
 * layer for per-run provider/model/effort/engine selection — the durable
 * surface YUK-1007's config panel will read/write in phase-2. `ctx.override`
 * stays the test/dev escape hatch and still wins per-field over modelBinding
 * when both are set (see explicitProviderRouting).
 */
export interface ModelBinding {
  /** Provider id from the providers.ts registry ('xiaomi' today; 'opencode-go' etc. as lanes land). */
  provider?: ResolvedProvider['provider'];
  /** Model id inside the resolved provider's catalog. */
  model?: string;
  /** Reasoning effort tier — same EffortLevel the task spec declares; explicit binding wins. */
  effort?: EffortLevel;
  /** Execution engine pin for the migration window; omit → resolved default ('sdk'). */
  adapter?: ExecutionAdapterId;
}

/**
 * Pi-adapter runner frames (YUK-921 P1). The pi agentLoop's events are
 * normalized into SDKMessage-shaped frames at the adapter boundary so the
 * consume loop (lifecycle/terminal/tool_call recording) stays a single
 * implementation; `source: 'pi'` declares provenance instead of faking
 * SDK-only metadata. Intersections stay structurally assignable to their SDK
 * member, so `sdk-terminal` and `isTaskEventMessage` consume them unchanged.
 * P1 emits assistant + result frames only (single-shot lane: no tools, no
 * compaction, no SDK init handshake to report).
 */
export type PiRunnerMessage =
  | (SDKAssistantMessage & { source: 'pi' })
  | (SDKResultMessage & { source: 'pi' })
  | (SDKUserMessage & { source: 'pi' });

/**
 * Message union consumed by runner entry points. P0 was a bare SDKMessage
 * alias; P1 unions in the pi-normalized frames both adapters may produce.
 */
export type RunnerMessage = SDKMessage | PiRunnerMessage;

/**
 * A prepared query session: transport started (admission already held by the
 * caller), prompt not yet submitted. `close()` must release either the unused
 * warm transport or the active query — the adapter owns that distinction.
 */
export interface PreparedExecutionQuery {
  query(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<RunnerMessage>;
  close(): Promise<void>;
}

/** Arguments every adapter's `startup` receives. Adapters consume what they need. */
export interface ExecutionAdapterStartupArgs {
  /** SDK Options built by buildQueryOptions (model/systemPrompt/effort/env/…). */
  options: Options;
  initializeTimeoutMs: number;
  /**
   * The lifecycle-resolved provider binding — credential, provider id and
   * model for this attempt. Pi adapter maps it to `models.getModel` and the
   * per-request `apiKey`; SDK adapter ignores it (its env is already inside
   * `options.env`).
   */
  resolved: ResolvedProvider;
  /**
   * The durable run identity (`ai_task_run.id`). Pi adapter injects it as the
   * opencode `x-opencode-session` header — stable per attempt, auditable.
   */
  runId: string;
  /** Registry kind — the pi adapter reads `needsToolCall` for its fail-closed tool-mount rule. */
  kind: TaskKind;
  /**
   * YUK-921 P2 — declarative tool mounts for the pi lane. Callers that want a
   * needsToolCall kind to be pi-eligible declare them alongside ctx.mcpServers
   * (the SDK lane keeps consuming mcpServers; the adapter gate picks which
   * surface applies). Ignored by the SDK adapter.
   */
  piToolMounts?: PiToolMount[];
}

export interface ExecutionAdapter {
  readonly id: ExecutionAdapterId;
  /** Start the transport without submitting a prompt (SDK WarmQuery equivalent). */
  startup(args: ExecutionAdapterStartupArgs): Promise<PreparedExecutionQuery>;
}

/**
 * Adapter A's prepared query — owns the warm-transport/active-query cleanup
 * order byte-for-byte from the pre-seam `withPreparedSdkQuery`. Exported so
 * the close-order contract can be pinned with a fake WarmQuery (the only real
 * logic in this file); not part of the adapter's public surface otherwise.
 */
export class SdkPreparedQuery implements PreparedExecutionQuery {
  private activeQuery: Query | undefined;

  constructor(private warmQuery: WarmQuery | undefined) {}

  query(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<RunnerMessage> {
    this.activeQuery = this.warmQuery?.query(prompt);
    if (!this.activeQuery) {
      throw new Error('SDK warm query closed before prompt submission');
    }
    return this.activeQuery;
  }

  async close(): Promise<void> {
    const query = this.activeQuery;
    this.activeQuery = undefined;
    const warm = this.warmQuery;
    this.warmQuery = undefined;
    if (query) {
      try {
        await query.return(undefined);
      } catch {
        query.close();
      }
      return;
    }
    warm?.close();
  }
}

class SdkExecutionAdapter implements ExecutionAdapter {
  readonly id = 'sdk' as const;

  async startup(args: ExecutionAdapterStartupArgs): Promise<PreparedExecutionQuery> {
    const warmQuery = await sdkStartup({
      options: args.options,
      initializeTimeoutMs: args.initializeTimeoutMs,
    });
    return new SdkPreparedQuery(warmQuery);
  }
}

const SDK_ADAPTER = new SdkExecutionAdapter();
const PI_ADAPTER = new PiAgentAdapter();

/**
 * YUK-921 P1/P2 — per-kind gray-rollout gate for the pi adapter, driven by the
 * `AI_ADAPTER_PI_KINDS` env flag (comma-separated task kinds; empty/unset ⇒
 * no kind may run pi). P1 restricted eligibility to needsToolCall=false
 * kinds; P2 opens tool-loop kinds — the fail-closed enforcement moved to
 * PiAgentAdapter.startup, which rejects a needsToolCall kind carrying zero
 * pi-visible tools. Parsed per call so tests can flip the env without
 * module reloads.
 */
export function piAllowlistedKinds(): ReadonlySet<string> {
  const raw = process.env.AI_ADAPTER_PI_KINDS;
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function isPiEligibleKind(kind: TaskKind): boolean {
  return piAllowlistedKinds().has(kind);
}

/**
 * Engine selection for one attempt. The default stays the SDK adapter; an
 * explicit `adapter:'pi'` pin resolves Adapter B only when BOTH gates hold:
 * the resolved provider is a pi lane (`isPiLaneProvider` — opencode-go today)
 * and the task kind is allowlisted (`AI_ADAPTER_PI_KINDS` ∩
 * needsToolCall=false). Every rejection fails closed with a config error —
 * same posture as `providerRequiresExplicitModel` — never a silent fallback.
 */
export function resolveExecutionAdapter(
  binding: ModelBinding | undefined,
  resolved: ResolvedProvider,
  kind: TaskKind,
): ExecutionAdapter {
  const requested = binding?.adapter ?? 'sdk';
  if (requested === 'pi') {
    if (!isPiLaneProvider(resolved.provider)) {
      throw new Error(
        `ExecutionAdapter 'pi' does not serve provider '${resolved.provider}' — only ${[...PI_LANE_PROVIDERS].join(' | ')} are wired through the pi lane (modelBinding.adapter:'pi' + modelBinding.provider:'${resolved.provider}' is not a runnable combination).`,
      );
    }
    if (!isPiEligibleKind(kind)) {
      throw new Error(
        `Task kind '${kind}' is not eligible for ExecutionAdapter 'pi' — only kinds named in AI_ADAPTER_PI_KINDS may run pi (needsToolCall=true kinds additionally require ctx.piToolMounts at startup). Omit the adapter pin to route through 'sdk'.`,
      );
    }
    return PI_ADAPTER;
  }
  if (requested !== 'sdk') {
    throw new Error(
      `ExecutionAdapter '${requested}' is not implemented — expected 'sdk' | 'pi'. Omit modelBinding.adapter or pass 'sdk'.`,
    );
  }
  if (isPiLaneProvider(resolved.provider)) {
    throw new Error(
      `Provider '${resolved.provider}' is served only by ExecutionAdapter 'pi' (its catalog is not Anthropic-protocol); set modelBinding.adapter:'pi' + an allowlisted needsToolCall=false kind.`,
    );
  }
  return SDK_ADAPTER;
}

/**
 * YUK-921 P2 — ops rollout pin. `AI_ADAPTER_PI_PROVIDER` +
 * `AI_ADAPTER_PI_MODEL` give allowlisted kinds a default pi binding when the
 * caller supplies no modelBinding of its own. An explicit per-run binding
 * always wins wholesale (a caller that names any field is expressing routing
 * intent — env defaults do not merge into it). The env pin alone is inert
 * without the kind also appearing in AI_ADAPTER_PI_KINDS, and the provider
 * must still be a pi lane — resolveExecutionAdapter enforces both
 * downstream.
 */
export function effectiveModelBinding(
  kind: TaskKind,
  binding: ModelBinding | undefined,
): ModelBinding | undefined {
  if (binding !== undefined) return binding;
  const provider = process.env.AI_ADAPTER_PI_PROVIDER?.trim();
  const model = process.env.AI_ADAPTER_PI_MODEL?.trim();
  if (!provider && !model) return binding;
  if (!piAllowlistedKinds().has(kind)) return binding;
  return {
    adapter: 'pi',
    ...(provider ? { provider: provider as ResolvedProvider['provider'] } : {}),
    ...(model ? { model } : {}),
  };
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
