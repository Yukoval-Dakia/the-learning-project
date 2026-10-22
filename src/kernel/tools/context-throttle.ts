// Per-message context budget for Copilot tool use: counts nodes+edges, event rows,
// and tool calls across one turn. Row tools are capped before execution; the
// tool-call gate returns a soft stop at the hard limit instead of throwing.
//
// beforeExecute sees only {name, effect}, so tool-call gating happens there and
// row accounting/capping happens in capInput.

import type { ContextBudget } from './budgets';
import { TOOL_COURTESY_DEFAULTS } from './budgets';
import type { ToolEffect } from './types';

/** Which budget dimension a given read tool's row count draws from. */
type RowBudgetDimension = 'nodesPlusEdges' | 'eventRows';
type BudgetDimension = 'toolCalls' | RowBudgetDimension;

// Only read tools with a courtesy default are row-budgeted; everything else counts
// only against the tool-call limit.
interface LimitedToolSpec {
  /** Path to the numeric limit param in the tool's args. */
  limitPath: readonly string[];
  /** Courtesy default applied when the caller omits the limit. */
  courtesyDefault: number;
  /** Which per-message budget dimension this tool's rows draw down. */
  dimension: RowBudgetDimension;
}

// Every budgeted limit param has a Zod minimum of 1. Sending 0 would make the
// tool's own re-parse throw, so an exhausted budget soft-stops instead.
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
  // Remaining bounded-row readers on the Copilot allowlist; defaults match each
  // tool's current default. get_question_context budgets the attempts timeline;
  // reviewLimit shares this dimension and is bounded by the tool's own max.
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
  // search_bank returns candidate rows, so it draws from eventRows. Its read/check
  // variants take ref arrays, not limits, and are limited only by tool calls.
  search_bank: {
    limitPath: ['limit'],
    courtesyDefault: 20,
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

// Clone along the path so the bridge can keep using the parsed input for logging.
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

export interface ContextBudgetDimensionStatus {
  used: number;
  warning_limit: number;
  hard_limit: number;
  hard_remaining: number;
}

/** Warning/hard-cap metadata attached to a tool output as `context_budget`. */
export interface ContextBudgetNotice {
  level: 'warning' | 'hard';
  dimensions: Partial<Record<BudgetDimension, ContextBudgetDimensionStatus>>;
  /** Set when this call was capped at a hard row ceiling. */
  truncated: boolean;
  /** Hard-truncation audit detail. */
  applied_limit?: number;
  requested_limit?: number;
  budget_remaining?: number;
  dimension?: RowBudgetDimension;
}

export interface CapInputResult {
  /** Unchanged at warning; capped only at hard. */
  args: unknown;
  /** Surfaced to the model and persisted in tool_call_log. */
  contextBudget: ContextBudgetNotice | null;
  /**
   * Set when the dimension cannot fund one row. The bridge skips execution and
   * returns this string as the tool result, so the agent answers with what it has.
   * Never sends limit:0.
   */
  softStop: string | null;
}

/**
 * Per-message context-budget accumulator, created once per turn and threaded into
 * the MCP bridge.
 */
export class ContextBudgetTracker {
  private toolCalls = 0;
  private nodesPlusEdgesUsed = 0;
  private eventRowsUsed = 0;

  constructor(private readonly budget: ContextBudget) {
    for (const dimension of ['toolCalls', 'nodesPlusEdges', 'eventRows'] as const) {
      const threshold = this.thresholdFor(dimension);
      if (threshold.warning > threshold.hard) {
        throw new Error(
          `Invalid ContextBudget: ${dimension} warning (${threshold.warning}) must be <= hard (${threshold.hard})`,
        );
      }
    }
  }

  /**
   * Hard tool-call gate shaped like the proposal cap: crossing the warning still
   * executes, only hard returns a soft stop.
   */
  beforeExecute(_tool: { name: string; effect: ToolEffect }): string | undefined {
    if (this.toolCalls >= this.budget.toolCalls.hard) {
      return `hard context budget reached (${this.toolCalls}/${this.budget.toolCalls.hard} tool calls); stop calling tools and answer with what you have`;
    }
    this.toolCalls += 1;
    return undefined;
  }

  /**
   * Account a read tool's limit: warn without changing args, cap only at hard.
   * Tools without a registered limit still receive tool-call notices.
   */
  capInput(toolName: string, args: unknown): CapInputResult {
    const spec = LIMITED_TOOLS[toolName];
    if (!spec) return { args, contextBudget: this.currentNotice(), softStop: null };

    const requested = readLimit(args, spec.limitPath) ?? spec.courtesyDefault;
    const remaining = this.remainingForHard(spec.dimension);

    // Do not execute with limit:0 (the tool's own Zod would throw); soft-stop instead.
    if (remaining < MIN_TOOL_ROWS) {
      return {
        args,
        contextBudget: this.currentNotice(),
        softStop: `hard context budget exhausted (${spec.dimension}: ${this.usedFor(spec.dimension)}/${this.thresholdFor(spec.dimension).hard}); stop calling read tools and answer with what you have`,
      };
    }

    // Clamp only against hard, so heavy-but-valid requests stay complete.
    const applied = Math.min(requested, remaining);

    // Charge what the tool may return; result size is not visible here.
    this.accountFor(spec.dimension, applied);

    const truncated = applied < requested;
    return {
      args: truncated ? writeLimit(args, spec.limitPath, applied) : args,
      contextBudget: this.currentNotice(
        truncated ? { applied, dimension: spec.dimension, requested } : undefined,
      ),
      softStop: null,
    };
  }

  private thresholdFor(dimension: BudgetDimension) {
    if (dimension === 'toolCalls') return this.budget.toolCalls;
    if (dimension === 'nodesPlusEdges') return this.budget.nodesPlusEdges;
    return this.budget.eventRows;
  }

  private usedFor(dimension: BudgetDimension): number {
    if (dimension === 'toolCalls') return this.toolCalls;
    if (dimension === 'nodesPlusEdges') return this.nodesPlusEdgesUsed;
    return this.eventRowsUsed;
  }

  private remainingForHard(dimension: BudgetDimension): number {
    return Math.max(0, this.thresholdFor(dimension).hard - this.usedFor(dimension));
  }

  private accountFor(dimension: RowBudgetDimension, amount: number): void {
    if (dimension === 'nodesPlusEdges') this.nodesPlusEdgesUsed += amount;
    else this.eventRowsUsed += amount;
  }

  /** Current warning state, shared by row caps and tool-call accounting. */
  currentNotice(truncation?: {
    applied: number;
    requested: number;
    dimension: RowBudgetDimension;
  }): ContextBudgetNotice | null {
    const dimensions: ContextBudgetNotice['dimensions'] = {};
    let hardReached = false;
    for (const dimension of ['toolCalls', 'nodesPlusEdges', 'eventRows'] as const) {
      const used = this.usedFor(dimension);
      const threshold = this.thresholdFor(dimension);
      if (used < threshold.warning) continue;
      dimensions[dimension] = {
        used,
        warning_limit: threshold.warning,
        hard_limit: threshold.hard,
        hard_remaining: this.remainingForHard(dimension),
      };
      if (used >= threshold.hard) hardReached = true;
    }
    if (Object.keys(dimensions).length === 0 && !truncation) return null;

    return {
      level: truncation || hardReached ? 'hard' : 'warning',
      dimensions,
      truncated: Boolean(truncation),
      ...(truncation
        ? {
            applied_limit: truncation.applied,
            requested_limit: truncation.requested,
            budget_remaining: this.remainingForHard(truncation.dimension),
            dimension: truncation.dimension,
          }
        : {}),
    };
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
