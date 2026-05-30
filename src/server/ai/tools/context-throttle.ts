// P5.1 Context Budget Policy (YUK-143) — per-message throttle.
// Spec: `docs/superpowers/specs/2026-05-31-p5.1-context-budget-design.md` §3.2 / §3.4.
//
// The NEW runtime piece. Copilot has no per-message budget today (it inherits
// only maxIterations:6 from the task registry). This tracker bounds the SUM of
// nodes+edges / event-rows / tool-calls a single user message contributes to
// the agent's context, across all the message's tool calls (§3.4 "tracked").
//
// It mirrors the per-run `proposalWrites` accumulator Dreaming/Coach already
// hold: a small mutable object created once per message/run and threaded into
// the same MCP-bridge construction path. Stateless-per-message is fine — the
// counter object is discarded when the turn ends.
//
// Two seams, because `beforeExecute` only sees {name, effect} (no args, no
// result):
//   1. tool-call ceiling → exposed as a `beforeExecute`-shaped gate that
//      returns a soft-stop string once maxToolCalls is reached (same mechanism
//      as the proposal cap; no thrown rejection).
//   2. limit cap + accounting + truncation note → exposed as `capInput` /
//      `accountOutput` the bridge calls around execute. We cap the REQUESTED
//      limit param down to remaining budget BEFORE execute, then account the
//      capped amount and attach a `{ applied_limit, budget_remaining,
//      truncated }` block to the output so the agent can self-correct (§5 Q2:
//      surface it, consistent with the existing filter_applied echo).

import type { ContextBudget } from './budgets';
import { TOOL_COURTESY_DEFAULTS } from './budgets';
import type { ToolEffect } from './types';

/** Which budget dimension a given read tool's row count draws from. */
type BudgetDimension = 'nodesPlusEdges' | 'eventRows';

// Map each limited read tool to:
//   - the JSON path of its limit param (top-level vs nested under `filter`)
//   - which budget dimension its returned rows consume
// Only tools with a courtesy default participate; everything else is counted
// for the tool-call ceiling only (no row capping).
interface LimitedToolSpec {
  /** Path to the numeric limit param in the tool's args. */
  limitPath: readonly string[];
  /** Courtesy default applied when the caller omits the limit. */
  courtesyDefault: number;
  /** Which per-message budget dimension this tool's rows draw down. */
  dimension: BudgetDimension;
}

const LIMITED_TOOLS: Record<string, LimitedToolSpec> = {
  query_knowledge: {
    limitPath: ['limit'],
    courtesyDefault: TOOL_COURTESY_DEFAULTS.query_knowledge,
    dimension: 'nodesPlusEdges',
  },
  expand_knowledge_subgraph: {
    limitPath: ['maxNodes'],
    courtesyDefault: TOOL_COURTESY_DEFAULTS.expand_knowledge_subgraph,
    dimension: 'nodesPlusEdges',
  },
  query_mistakes: {
    limitPath: ['filter', 'limit'],
    courtesyDefault: TOOL_COURTESY_DEFAULTS.query_mistakes,
    dimension: 'eventRows',
  },
  query_events: {
    limitPath: ['filter', 'limit'],
    courtesyDefault: TOOL_COURTESY_DEFAULTS.query_events,
    dimension: 'eventRows',
  },
  get_attempt_context: {
    limitPath: ['timelineLimit'],
    courtesyDefault: TOOL_COURTESY_DEFAULTS.get_attempt_context,
    dimension: 'eventRows',
  },
};

function readLimit(args: unknown, path: readonly string[]): number | undefined {
  let cur: unknown = args;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' ? cur : undefined;
}

// Returns a shallow-cloned args object with the limit at `path` set to `value`.
// Never mutates the input (the bridge re-uses parsedInput for logging).
function writeLimit(args: unknown, path: readonly string[], value: number): unknown {
  const root: Record<string, unknown> =
    args !== null && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {};
  let cur = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const next = cur[key];
    cur[key] = next !== null && typeof next === 'object' ? { ...(next as object) } : {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
  return root;
}

/** Truncation metadata attached to a capped tool output (§5 Q2). */
export interface ContextBudgetTruncation {
  /** The effective limit the tool actually ran with after capping. */
  applied_limit: number;
  /** The limit the agent asked for (or the courtesy default when omitted). */
  requested_limit: number;
  /** Remaining budget in the relevant dimension after this call accounted. */
  budget_remaining: number;
  /** True when applied_limit < requested_limit (the agent got fewer rows). */
  truncated: boolean;
  /** Which dimension was drawn down. */
  dimension: BudgetDimension;
}

export interface CapInputResult {
  /** Args to actually execute with (limit capped down to remaining budget). */
  args: unknown;
  /** Set when the requested limit was capped; null when nothing was throttled. */
  truncation: ContextBudgetTruncation | null;
}

/**
 * Per-message (or per-run) context-budget accumulator. Created once per
 * Copilot user message and threaded into the MCP bridge. Mirrors the per-run
 * `proposalWrites` counter Dreaming/Coach already hold.
 */
export class ContextBudgetTracker {
  private toolCalls = 0;
  private nodesPlusEdgesUsed = 0;
  private eventRowsUsed = 0;

  constructor(private readonly budget: ContextBudget) {}

  /**
   * Tool-call ceiling gate, shaped exactly like the existing proposal-cap
   * `beforeExecute`: returns a soft-stop string once maxToolCalls is reached
   * (the model reads it as the tool result and stops), otherwise increments
   * the counter and returns undefined. No thrown rejection (§6).
   *
   * Counts every DomainTool invocation (read / propose / write) against the
   * per-message tool-call budget, since each call adds to the context.
   */
  beforeExecute(_tool: { name: string; effect: ToolEffect }): string | undefined {
    if (this.toolCalls >= this.budget.maxToolCalls) {
      return `context budget reached (${this.budget.maxToolCalls} tool calls); stop calling tools and answer with what you have`;
    }
    this.toolCalls += 1;
    return undefined;
  }

  /**
   * Cap a read tool's requested limit down to whatever the per-message budget
   * has left in the relevant dimension, applying the courtesy default when the
   * caller omitted the limit (CB-5). Returns the args to execute with plus
   * optional truncation metadata. Tools without a registered limit param pass
   * through untouched (only the tool-call ceiling applies to them).
   */
  capInput(toolName: string, args: unknown): CapInputResult {
    const spec = LIMITED_TOOLS[toolName];
    if (!spec) return { args, truncation: null };

    const requested = readLimit(args, spec.limitPath) ?? spec.courtesyDefault;
    const remaining = this.remainingFor(spec.dimension);
    const applied = Math.max(0, Math.min(requested, remaining));

    // Account the (capped) amount up front. Row counting is request-side: we
    // charge what the tool is permitted to return, not the post-hoc result
    // size (beforeExecute / the bridge cannot see result size; CB-6 row count
    // is adequate to prevent bloat).
    this.accountFor(spec.dimension, applied);

    // Nothing was capped: pass args through UNCHANGED (don't materialize an
    // omitted limit into the args, don't echo a truncation note). The tool
    // applies its own courtesy default exactly as before.
    if (applied === requested) {
      return { args, truncation: null };
    }

    // Capped: rewrite the limit down to what fits + surface the truncation note
    // so the agent can self-correct (graceful degradation, never a throw).
    return {
      args: writeLimit(args, spec.limitPath, applied),
      truncation: {
        applied_limit: applied,
        requested_limit: requested,
        budget_remaining: this.remainingFor(spec.dimension),
        truncated: true,
        dimension: spec.dimension,
      },
    };
  }

  private remainingFor(dimension: BudgetDimension): number {
    return dimension === 'nodesPlusEdges'
      ? this.budget.maxNodesPlusEdges - this.nodesPlusEdgesUsed
      : this.budget.maxEventRows - this.eventRowsUsed;
  }

  private accountFor(dimension: BudgetDimension, amount: number): void {
    if (dimension === 'nodesPlusEdges') this.nodesPlusEdgesUsed += amount;
    else this.eventRowsUsed += amount;
  }

  /** Test/observability snapshot. */
  snapshot(): {
    toolCalls: number;
    nodesPlusEdgesUsed: number;
    eventRowsUsed: number;
  } {
    return {
      toolCalls: this.toolCalls,
      nodesPlusEdgesUsed: this.nodesPlusEdgesUsed,
      eventRowsUsed: this.eventRowsUsed,
    };
  }
}
