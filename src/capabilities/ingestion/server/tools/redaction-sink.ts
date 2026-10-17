import type { IngestionRedactionField, IngestionRedactionResult } from '../privacy-guard';
import type { ToolContext } from './types';

// YUK-1522 (R8) — run-scoped redaction accounting. Every tool that returns
// source text into the agent loop (read_source, glm_ocr, preview/ask redaction
// at the contract boundary) reports its redactIngestionText result here; the
// orchestrator folds the sink into the per-run usage receipt so
// redacted_fields / redaction_counts are true, not decorative.
//
// Keyed by the per-segment ToolContext (WeakMap — no lifetime bookkeeping:
// the entry dies with the run).

export interface AgentRedactionSink {
  readonly fields: Set<IngestionRedactionField>;
  readonly counts: Partial<Record<IngestionRedactionField, number>>;
}

const sinks = new WeakMap<ToolContext, AgentRedactionSink>();

/** Attach a fresh sink; the orchestrator calls this once per segment. */
export function attachAgentRedactionSink(ctx: ToolContext): AgentRedactionSink {
  const sink: AgentRedactionSink = { fields: new Set(), counts: {} };
  sinks.set(ctx, sink);
  return sink;
}

export function recordAgentRedaction(
  ctx: ToolContext,
  result: Pick<IngestionRedactionResult, 'fields' | 'counts'>,
): void {
  const sink = sinks.get(ctx);
  if (sink == null) return;
  for (const field of result.fields) {
    sink.fields.add(field);
    const count = result.counts[field];
    if (count != null) sink.counts[field] = (sink.counts[field] ?? 0) + count;
  }
}
