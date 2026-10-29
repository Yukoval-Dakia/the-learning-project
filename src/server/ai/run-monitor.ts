// YUK-1661 (YUK-1559 first slice) — run-scoped, report-only observation of
// repeated tool executions with identical arguments. Counts only actual
// `AgentTool.execute` crossings at the allTools.execute seam shared by root
// and nested loops — never tool_execution_start/end, which also fire for
// validation-rejected, missing-tool and hook-blocked calls. T3 wires this into
// pi-agent-adapter in the same PR; until then the module intentionally has no
// consumer. Zero DB/provider/runner dependencies.
//
// Privacy: raw arguments and the comparison key never leave this module; the
// observation carries counts plus an opaque instance-scoped repeatGroup id.
// Nothing here blocks, retries, or otherwise changes execution — report-only.

import { createHash } from 'node:crypto';

/**
 * Same-input executions in one group at which the future hard-stop (YUK-1558
 * C2) would fire. This slice only reports the crossing; it never enforces.
 */
export const REPEAT_TRIGGER_THRESHOLD = 5;

/** One actual execution. Args are the post-prepareArguments values the tool really received. */
export interface ObserveExecutedToolInput {
  toolName: string;
  callId: string;
  args: unknown;
}

/**
 * `structural_json` = grouped by deterministic JSON structure.
 * `comparison_unavailable` = args held non-JSON values; no group is claimed
 * and no count beyond this execution is implied.
 */
export type RunMonitorComparison = 'structural_json' | 'comparison_unavailable';

export interface RunMonitorObservation {
  mode: 'report_only';
  comparison: RunMonitorComparison;
  /** Executions in this repeat group, this one included; 1 (this execution alone) when comparison is unavailable. */
  sameInputExecutions: number;
  /** True from the threshold-crossing execution onward. Reported only — execution is never stopped here. */
  wouldTrigger: boolean;
  /** Opaque id unique within this monitor instance; carries no argument data. Null when comparison is unavailable. */
  repeatGroup: string | null;
}

export interface RunMonitorGroupSnapshot {
  repeatGroup: string;
  toolName: string;
  executions: number;
  wouldTrigger: boolean;
}

/**
 * Immutable point-in-time view. `totalExecutions` always equals the sum of
 * `groups[].executions` plus `comparisonUnavailableExecutions`.
 */
export interface RunMonitorSnapshot {
  mode: 'report_only';
  triggerThreshold: number;
  totalExecutions: number;
  comparisonUnavailableExecutions: number;
  groups: readonly RunMonitorGroupSnapshot[];
}

export interface RunMonitor {
  /**
   * Record exactly one actual execute crossing. Total: never throws — args
   * that are not comparable as JSON degrade to `comparison_unavailable`
   * without touching the execution they describe. Grouping is by toolName +
   * args structure; callId is carried for call-site identity only.
   */
  observeExecutedTool(input: ObserveExecutedToolInput): RunMonitorObservation;
  /** Fresh copy every call; nothing is cached between observations. */
  snapshot(): RunMonitorSnapshot;
}

interface RepeatGroup {
  id: string;
  toolName: string;
  executions: number;
}

export function createRunMonitor(): RunMonitor {
  // Keyed by SHA-256 of toolName + canonical args so the reversible canonical
  // form is never retained in memory beyond the observing call.
  const groupsByDigest = new Map<string, RepeatGroup>();
  let groupSequence = 0;
  let totalExecutions = 0;
  let comparisonUnavailableExecutions = 0;

  const unavailableObservation = (): RunMonitorObservation => ({
    mode: 'report_only',
    comparison: 'comparison_unavailable',
    sameInputExecutions: 1,
    wouldTrigger: false,
    repeatGroup: null,
  });

  return {
    observeExecutedTool({ toolName, args }) {
      totalExecutions += 1;
      try {
        const digest = groupDigest(toolName, args);
        if (digest === undefined) {
          comparisonUnavailableExecutions += 1;
          return unavailableObservation();
        }
        let group = groupsByDigest.get(digest);
        if (group === undefined) {
          groupSequence += 1;
          group = { id: `rg-${groupSequence}`, toolName, executions: 0 };
          groupsByDigest.set(digest, group);
        }
        group.executions += 1;
        return {
          mode: 'report_only',
          comparison: 'structural_json',
          sameInputExecutions: group.executions,
          wouldTrigger: group.executions >= REPEAT_TRIGGER_THRESHOLD,
          repeatGroup: group.id,
        };
      } catch {
        // Exotic argument shapes (e.g. throwing proxy traps) must not reach
        // the execution path; degrade to comparison_unavailable instead.
        comparisonUnavailableExecutions += 1;
        return unavailableObservation();
      }
    },

    snapshot() {
      return {
        mode: 'report_only',
        triggerThreshold: REPEAT_TRIGGER_THRESHOLD,
        totalExecutions,
        comparisonUnavailableExecutions,
        groups: [...groupsByDigest.values()].map((group) => ({
          repeatGroup: group.id,
          toolName: group.toolName,
          executions: group.executions,
          wouldTrigger: group.executions >= REPEAT_TRIGGER_THRESHOLD,
        })),
      };
    },
  };
}

type CanonicalResult = { comparable: true; canonical: string } | { comparable: false };

const NOT_COMPARABLE: CanonicalResult = { comparable: false };

// Deep-but-valid JSON is fine; recursion past this is treated as
// incomparable rather than risking the call stack.
const MAX_COMPARE_DEPTH = 512;

/**
 * Canonical JSON form: object keys sorted by code unit (insertion order
 * irrelevant), array order preserved, and every value type keeping a distinct
 * encoding — `-0` apart from `0`, missing keys apart from null ones. Anything
 * outside the JSON domain (undefined, bigint, functions, symbols, non-plain
 * objects, cycles, non-finite numbers) makes the whole value incomparable
 * instead of being silently coerced into a false group. Injective over the
 * JSON domain, so equal digests mean structurally identical arguments.
 */
function canonicalJson(value: unknown, seen: Set<object>, depth: number): CanonicalResult {
  if (value === null) return { comparable: true, canonical: 'null' };
  switch (typeof value) {
    case 'boolean':
      return { comparable: true, canonical: value ? 'true' : 'false' };
    case 'number':
      if (!Number.isFinite(value)) return NOT_COMPARABLE;
      return { comparable: true, canonical: Object.is(value, -0) ? '-0' : String(value) };
    case 'string':
      return { comparable: true, canonical: JSON.stringify(value) };
    case 'object': {
      if (depth >= MAX_COMPARE_DEPTH || seen.has(value)) return NOT_COMPARABLE;
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (const item of value) {
            const part = canonicalJson(item, seen, depth + 1);
            if (!part.comparable) return part;
            parts.push(part.canonical);
          }
          return { comparable: true, canonical: `[${parts.join(',')}]` };
        }
        // Only plain objects are JSON structure; class instances, Date, Map,
        // … carry state beyond JSON and make the args incomparable.
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return NOT_COMPARABLE;
        if (Object.getOwnPropertySymbols(value).length > 0) return NOT_COMPARABLE;
        const record = value as Record<string, unknown>;
        const parts: string[] = [];
        for (const key of Object.keys(record).sort()) {
          const part = canonicalJson(record[key], seen, depth + 1);
          if (!part.comparable) return part;
          parts.push(`${JSON.stringify(key)}:${part.canonical}`);
        }
        return { comparable: true, canonical: `{${parts.join(',')}}` };
      } finally {
        seen.delete(value);
      }
    }
    default:
      return NOT_COMPARABLE;
  }
}

/**
 * Full (untruncated) SHA-256 over toolName + canonical args, so identical
 * arguments under different tools stay separate groups. Undefined when the
 * args are not comparable as JSON.
 */
function groupDigest(toolName: string, args: unknown): string | undefined {
  const result = canonicalJson(args, new Set(), 0);
  if (!result.comparable) return undefined;
  return createHash('sha256')
    .update(JSON.stringify([toolName, result.canonical]))
    .digest('hex');
}
