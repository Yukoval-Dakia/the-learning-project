// YUK-1661 (YUK-1559 slice) — run-scoped, report-only monitor for repeated
// tool executions. Counts actual executions per tool + identical arguments at
// the `allTools.execute` seam shared by the root loop and nested sub loops —
// never at tool_execution_start/end. Nothing here intercepts, blocks, or
// mutates execution; the hard-stop and caps are YUK-1558 and land with T3.
//
// Privacy: raw argument values never leave this module. Trace metadata carries
// only a digest, keeping private business data out of telemetry.

import { createHash } from 'node:crypto';

/** Same-argument execution count at which the (future) hard-stop would fire. */
export const RUN_REPEAT_THRESHOLD = 5;

/** Laminar-safe attributes to spread into the `tool.execute` span metadata. */
export interface RunRepeatTraceMetadata {
  /** Digest of tool name + canonical arguments — the exact counting key. */
  repeat_signature: string;
  /** Actual executions with these arguments so far, this one included. */
  repeat_count: number;
  /** This execution reached the threshold. Reported, never acted on. */
  repeat_would_trigger: boolean;
}

export interface RunRepeatObservation {
  /** Same-argument execution count after this execution (>= 1). */
  count: number;
  /** True from the threshold-crossing execution onwards. */
  wouldTrigger: boolean;
  /** Spread into the existing `traceOperation('tool.execute')` metadata. */
  traceMetadata: RunRepeatTraceMetadata;
}

export interface RunMonitor {
  /**
   * Record one actual tool execution — exactly once per execute call, with the
   * validated arguments the tool received (pi passes them as `params`).
   */
  recordExecution(toolName: string, args: unknown): RunRepeatObservation;
}

/** Counting state for one (tool, canonical arguments) pair. */
interface RepeatCounter {
  signature: string;
  count: number;
}

export function createRunMonitor(): RunMonitor {
  const counters = new Map<string, RepeatCounter>();
  return {
    recordExecution(toolName, args) {
      const signature = executionSignature(toolName, args);
      const counter = counters.get(signature) ?? { signature, count: 0 };
      counter.count += 1;
      counters.set(signature, counter);
      const wouldTrigger = counter.count >= RUN_REPEAT_THRESHOLD;
      return {
        count: counter.count,
        wouldTrigger,
        traceMetadata: {
          repeat_signature: signature,
          repeat_count: counter.count,
          repeat_would_trigger: wouldTrigger,
        },
      };
    },
  };
}

const SIGNATURE_HEX_CHARS = 16;

/**
 * SHA-256 digest of tool name + canonical arguments, truncated to 64 bits. A
 * run-scoped counter sees far too few calls for collisions to matter, and the
 * short form keeps the counting key's memory bounded by call count, not arg
 * size. The NUL separator cannot occur in either input, so the split is unique.
 */
function executionSignature(toolName: string, args: unknown): string {
  return createHash('sha256')
    .update(`${toolName}\u0000${canonicalJson(args, new WeakSet(), 0)}`)
    .digest('hex')
    .slice(0, SIGNATURE_HEX_CHARS);
}

const MAX_CANONICAL_DEPTH = 32;

/**
 * Deterministic JSON form with recursively sorted object keys, so argument
 * objects differing only in key order count as the same call. Total by
 * construction: depth-capped, cycle-guarded, and exotic values (undefined,
 * functions, bigint, non-finite numbers) get stable tags instead of throwing.
 * Non-plain objects degrade to their enumerable own structure, which is fine
 * for a report-only counter — validated tool args are plain JSON.
 */
function canonicalJson(value: unknown, seen: WeakSet<object>, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? `${value}` : JSON.stringify(String(value));
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return `${value}`;
    case 'bigint':
      return JSON.stringify(`${value.toString()}n`);
    case 'object': {
      if (depth >= MAX_CANONICAL_DEPTH) return '"<max-depth>"';
      if (seen.has(value)) return '"<circular>"';
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalJson(item, seen, depth + 1)).join(',')}]`;
        }
        const record = value as Record<string, unknown>;
        const body = Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen, depth + 1)}`)
          .join(',');
        return `{${body}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      return '"<non-json>"';
  }
}
