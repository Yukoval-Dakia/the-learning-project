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
  type SDKMessage,
  type SDKUserMessage,
  type WarmQuery,
  startup as sdkStartup,
} from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel } from '@/ai/task-spec';
import type { ResolvedProvider } from './providers';

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
 * Message union consumed by runner entry points. P0: alias to SDKMessage so
 * every consumer compiles unchanged; P1 unions in the pi AgentMessage shape.
 */
export type RunnerMessage = SDKMessage;

/**
 * A prepared query session: transport started (admission already held by the
 * caller), prompt not yet submitted. `close()` must release either the unused
 * warm transport or the active query — the adapter owns that distinction.
 */
export interface PreparedExecutionQuery {
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
  close(): Promise<void>;
}

export interface ExecutionAdapter {
  readonly id: ExecutionAdapterId;
  /** Start the transport without submitting a prompt (SDK WarmQuery equivalent). */
  startup(args: { options: Options; initializeTimeoutMs: number }): Promise<PreparedExecutionQuery>;
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

  query(prompt: string | AsyncIterable<SDKUserMessage>): Query {
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

  async startup(args: {
    options: Options;
    initializeTimeoutMs: number;
  }): Promise<PreparedExecutionQuery> {
    const warmQuery = await sdkStartup({
      options: args.options,
      initializeTimeoutMs: args.initializeTimeoutMs,
    });
    return new SdkPreparedQuery(warmQuery);
  }
}

const SDK_ADAPTER = new SdkExecutionAdapter();

/**
 * Engine selection for one attempt. Today every binding resolves to the SDK
 * adapter; an explicit `adapter:'pi'` pin fails closed (same posture as
 * providerRequiresExplicitModel) rather than silently falling back.
 */
export function resolveExecutionAdapter(binding?: ModelBinding): ExecutionAdapter {
  if (binding?.adapter !== undefined && binding.adapter !== 'sdk') {
    throw new Error(
      `ExecutionAdapter '${binding.adapter}' is not implemented yet — only 'sdk' is available in this release (pi lands in YUK-921 P1). Omit modelBinding.adapter or pass 'sdk'.`,
    );
  }
  return SDK_ADAPTER;
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
