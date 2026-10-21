import type { IngestionRedactionField, IngestionRedactionResult } from '../privacy-guard';
import type { ToolContext } from './types';

// Run-scoped redaction accounting. Tools that return source text report their
// redaction result here, and the orchestrator folds it into the segment receipt.
//
// Keyed by ingestion scope id, not the context object: the bridge clones ctx, so
// object identity would miss on every real call.

export interface AgentRedactionSink {
  readonly fields: Set<IngestionRedactionField>;
  readonly counts: Partial<Record<IngestionRedactionField, number>>;
  /** Texts already counted this run — window re-reads never double-count. */
  readonly countedKeys: Set<string>;
  /** Full-text redactions cached per unique source text (R2-1). */
  readonly cache: Map<string, IngestionRedactionResult>;
}

const sinks = new Map<string, AgentRedactionSink>();

function scopeKey(ctx: ToolContext): string | undefined {
  const scope = ctx.scope as { kind?: string; id?: string } | undefined;
  return scope?.kind === 'ingestion_session' ? scope.id : undefined;
}

/** Attach a fresh sink for this run's scope; the orchestrator calls once per segment. */
export function attachAgentRedactionSink(scopeId: string): AgentRedactionSink {
  const sink: AgentRedactionSink = {
    fields: new Set(),
    counts: {},
    countedKeys: new Set(),
    cache: new Map(),
  };
  sinks.set(scopeId, sink);
  return sink;
}

/** Release the scope's sink when the segment ends (worker lifetime is unbounded). */
export function detachAgentRedactionSink(scopeId: string): void {
  sinks.delete(scopeId);
}

/** The orchestrator holds the attach-returned handle for the receipt write. */
export function readAgentRedactionSink(scopeId: string): AgentRedactionSink | undefined {
  return sinks.get(scopeId);
}

function fold(
  sink: AgentRedactionSink,
  result: Pick<IngestionRedactionResult, 'fields' | 'counts'>,
): void {
  for (const field of result.fields) {
    sink.fields.add(field);
    const count = result.counts[field];
    if (count != null) sink.counts[field] = (sink.counts[field] ?? 0) + count;
  }
}

/** Fold a redaction result into the run's sink (no-op when the ctx carries no run sink). */
export function recordAgentRedaction(
  ctx: ToolContext,
  result: Pick<IngestionRedactionResult, 'fields' | 'counts'>,
): void {
  const id = scopeKey(ctx);
  const sink = id != null ? sinks.get(id) : undefined;
  if (sink == null) return;
  fold(sink, result);
}

/**
 * Fold a redaction result once per unique text key — re-windows of the same
 * source text never inflate the receipt's counts.
 */
export function recordAgentRedactionOnce(
  ctx: ToolContext,
  key: string,
  result: Pick<IngestionRedactionResult, 'fields' | 'counts'>,
): void {
  const id = scopeKey(ctx);
  const sink = id != null ? sinks.get(id) : undefined;
  if (sink == null || sink.countedKeys.has(key)) return;
  sink.countedKeys.add(key);
  fold(sink, result);
}

/**
 * Cache for full-text redactions (R2-1: redact whole page/doc once, then
 * window). Returns the cached result when this run already redacted `key`.
 */
export function cachedAgentRedaction(
  ctx: ToolContext,
  key: string,
  compute: () => IngestionRedactionResult,
): IngestionRedactionResult {
  const id = scopeKey(ctx);
  const sink = id != null ? sinks.get(id) : undefined;
  if (sink == null) return compute();
  const hit = sink.cache.get(key);
  if (hit != null) return hit;
  const result = compute();
  sink.cache.set(key, result);
  sink.countedKeys.add(key);
  fold(sink, result);
  return result;
}
