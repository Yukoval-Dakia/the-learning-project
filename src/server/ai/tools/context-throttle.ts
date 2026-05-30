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

// Every budgeted read tool's limit param has a Zod minimum of 1 (verified in
// knowledge-readers.ts / query-mistakes.ts / query-events.ts /
// get-attempt-context.ts / context-readers.ts). So an effective limit < 1 can
// never be a valid execute arg — sending `limit:0` would make the tool's own
// Zod re-parse THROW. We never do that: when the budget can't fund even one
// row, capInput short-circuits to a graceful soft-stop instead (FIX 1).
const MIN_TOOL_ROWS = 1;

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
  // FIX 2 (YUK-143) — the other bounded-row readers on the Copilot allowlist
  // (COPILOT_TOOLS in allowlists.ts) so maxEventRows is enforced across ALL
  // Copilot row tools, not just the original 5 (spec §7). Defaults are the
  // tools' CURRENT defaults (no behavior change), verified in context-readers.ts:
  //   - query_records.limit            default 20, rows ≤ 50   (~L155 / L226)
  //   - get_review_due.limit           default 20, queue ≤ 50  (~L684 / L728)
  //   - get_question_context.attemptLimit default 10, attempts+reviews timeline
  //     (~L484 / L582). This tool also takes a reviewLimit (default 10) on the
  //     same dimension; we budget the attempts timeline (the dominant row
  //     source) as the v1 proxy — the reviewLimit rows are bounded ≤ 50 by the
  //     tool's own Zod max and share this eventRows budget transitively. Both
  //     paths still pass through the tool-call ceiling.
  query_records: {
    limitPath: ['limit'],
    courtesyDefault: 20,
    dimension: 'eventRows',
  },
  get_review_due: {
    limitPath: ['limit'],
    courtesyDefault: 20,
    dimension: 'eventRows',
  },
  get_question_context: {
    limitPath: ['attemptLimit'],
    courtesyDefault: 10,
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
  /**
   * Set ONLY when the dimension is exhausted (cannot fund even one row). The
   * bridge treats this exactly like a `beforeExecute` gate reason: it does NOT
   * execute the tool and surfaces the string as the tool result, so the agent
   * stops calling read tools and answers with what it has. This is the same
   * graceful soft-stop as the tool-call ceiling — NEVER a thrown error and
   * NEVER a `limit:0` arg sent to a tool (FIX 1 / spec §6 non-goal). Null on
   * the pass-through and partial-truncation paths.
   */
  softStop: string | null;
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
    if (!spec) return { args, truncation: null, softStop: null };

    const requested = readLimit(args, spec.limitPath) ?? spec.courtesyDefault;
    const remaining = this.remainingFor(spec.dimension);

    // EXHAUSTED: the dimension can't fund even one row (remaining < the tool's
    // min of 1). Do NOT execute with limit:0 — that would make the tool's own
    // Zod re-parse THROW, breaking the spec's central "never a hard reject"
    // guarantee (§6). Short-circuit via the SAME soft-stop mechanism as the
    // tool-call ceiling: return a string the bridge surfaces as the tool
    // result, so the agent stops calling read tools and answers with what it
    // has. No accounting (nothing ran), no truncation note (nothing returned).
    if (remaining < MIN_TOOL_ROWS) {
      return {
        args,
        truncation: null,
        softStop: `context budget exhausted (${spec.dimension}); stop calling read tools and answer with what you have`,
      };
    }

    // PARTIAL or FULL: clamp the requested limit down to what's left, but never
    // below the tool's min of 1 — we return SOME rows, never 0. Since
    // remaining >= 1 here, `min(requested, remaining)` is already >= 1.
    const applied = Math.min(requested, remaining);

    // Account the (capped) amount up front. Row counting is request-side: we
    // charge what the tool is permitted to return, not the post-hoc result
    // size (beforeExecute / the bridge cannot see result size; CB-6 row count
    // is adequate to prevent bloat).
    this.accountFor(spec.dimension, applied);

    // Nothing was capped: pass args through UNCHANGED (don't materialize an
    // omitted limit into the args, don't echo a truncation note). The tool
    // applies its own courtesy default exactly as before.
    if (applied === requested) {
      return { args, truncation: null, softStop: null };
    }

    // Capped (but >= 1): rewrite the limit down to what fits + surface the
    // truncation note so the agent can self-correct (graceful degradation,
    // truncated-but-non-empty, never a throw).
    return {
      args: writeLimit(args, spec.limitPath, applied),
      truncation: {
        applied_limit: applied,
        requested_limit: requested,
        budget_remaining: this.remainingFor(spec.dimension),
        truncated: true,
        dimension: spec.dimension,
      },
      softStop: null,
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
