// P5.1 Context Budget Policy (YUK-143) — spec
// `docs/superpowers/specs/2026-05-31-p5.1-context-budget-design.md`.
//
// Single tunable source of truth for per-surface DomainTool context budgets.
// Before P5.1 these numbers were smeared across 7 files (knowledge-readers,
// query-mistakes, query-events, get-attempt-context, dreaming_nightly,
// coach_daily). This module consolidates them so future tuning is deliberate
// and in one place (CB-1).
//
// IO-free / no dependencies — pure constants + a small lookup. Counting unit is
// node / edge / event-row for v1 (CB-6); token-level accounting is deferred to
// the T-PD backlog (the inactive `maxCost` in src/ai/registry.ts). No
// user-configurable budgets (CB-5) and no hard-reject circuit-breaker (§6):
// over-budget degrades gracefully via the tracker below.

import type { DomainToolSurface } from './allowlists';

export interface ContextBudget {
  /** Max DomainTool invocations counted against this budget for the run/message. */
  maxToolCalls: number;
  /** Max combined knowledge nodes + edges returned across the run/message. */
  maxNodesPlusEdges: number;
  /** Max event-table rows (query_events + query_mistakes + timelines) across the run/message. */
  maxEventRows: number;
  /** Max characters per text excerpt (prompt / answer / reasoning snippet). */
  maxExcerptChars: number;
  /** Existing Dreaming/Coach proposal-write cap; undefined for read-only surfaces. */
  maxProposals?: number;
}

// CB-2 — Copilot per-user-message budget (loosened). Single-user self-hosted;
// Copilot is user-facing and streams, so the user sees + recovers from any
// truncation. Generous-but-bounded; the bound exists only to stop context
// bloat that would distort reasoning. 180 aligns to knowledge-readers'
// TEXT_SNIPPET_MAX (the existing per-excerpt max).
export const COPILOT_CONTEXT_BUDGET: ContextBudget = {
  maxToolCalls: 10,
  maxNodesPlusEdges: 250,
  maxEventRows: 1000,
  maxExcerptChars: 180,
};

// CB-3 — Dreaming budget unchanged. `maxToolCalls: 8` and `maxProposals: 5`
// are the numbers previously hardcoded in dreaming_nightly.ts
// (`max_tool_calls` literal + DREAMING_MAX_PROPOSALS). The nodes/edges/events
// ceilings DOCUMENT the prior implicit ceiling (same generous values as
// Copilot); Dreaming already stops on maxToolCalls / maxProposals well before
// it could approach them, so they change no observable behavior (§3.1, §7).
export const DREAMING_CONTEXT_BUDGET: ContextBudget = {
  maxToolCalls: 8,
  maxNodesPlusEdges: 250,
  maxEventRows: 1000,
  maxExcerptChars: 180,
  maxProposals: 5,
};

// CB-4 — Coach budget unchanged. `maxToolCalls: 12` and `maxProposals: 5` are
// the numbers previously hardcoded in coach_daily.ts (`max_tool_calls` literal
// + COACH_MAX_PROPOSALS). Same documentation-of-prior-ceiling note as Dreaming.
export const COACH_CONTEXT_BUDGET: ContextBudget = {
  maxToolCalls: 12,
  maxNodesPlusEdges: 250,
  maxEventRows: 1000,
  maxExcerptChars: 180,
  maxProposals: 5,
};

// §3.1 — keying budgets by DomainToolSurface is the natural fit. A fourth
// surface (maintenance) and the knowledge_review / chip surfaces fall back to a
// generous default until they need an explicit budget. The chip surface shares
// the Copilot budget because it runs the same user-facing CopilotTask path.
const GENERIC_CONTEXT_BUDGET: ContextBudget = {
  maxToolCalls: 12,
  maxNodesPlusEdges: 250,
  maxEventRows: 1000,
  maxExcerptChars: 180,
};

export const BUDGETS_BY_SURFACE: Record<DomainToolSurface, ContextBudget> = {
  copilot: COPILOT_CONTEXT_BUDGET,
  copilot_user_suggested_mistake_action: COPILOT_CONTEXT_BUDGET,
  dreaming: DREAMING_CONTEXT_BUDGET,
  coach: COACH_CONTEXT_BUDGET,
  knowledge_review: GENERIC_CONTEXT_BUDGET,
  maintenance: GENERIC_CONTEXT_BUDGET,
};

export function resolveContextBudget(surface: DomainToolSurface): ContextBudget {
  return BUDGETS_BY_SURFACE[surface];
}

// ── Per-tool courtesy defaults (CB-5) ───────────────────────────────────────
//
// The value a read tool returns when the caller omits a `limit`. These are the
// tools' CURRENT defaults (NOT a behavior change) — centralized here so the
// single tunable source documents both the per-surface budget AND the per-call
// courtesy default. The tool runtime applies min(courtesy default, caller
// requested limit, remaining budget) per the throttle below.
//
// Verified against the tool implementations:
//   - query_knowledge.limit          default 10  (knowledge-readers.ts)
//   - expand_knowledge_subgraph.maxNodes default 30 (knowledge-readers.ts)
//   - query_mistakes.filter.limit     default 20  (query-mistakes.ts)
//   - query_events.filter.limit       default 20  (query-events.ts)
//   - get_attempt_context.timelineLimit default 10 (get-attempt-context.ts)
export const TOOL_COURTESY_DEFAULTS = {
  query_knowledge: 10,
  expand_knowledge_subgraph: 30,
  query_mistakes: 20,
  query_events: 20,
  get_attempt_context: 10,
} as const satisfies Record<string, number>;

export type CourtesyDefaultToolName = keyof typeof TOOL_COURTESY_DEFAULTS;

// ── Per-excerpt character caps (§3.2 step 4) ────────────────────────────────
//
// Centralized here so budgets.ts is the single source for the excerpt caps in
// the §1 inventory. Values are byte-identical to the prior file-local
// constants — this is documentation/relocation, NOT a behavior change:
//   - KNOWLEDGE_EXCERPT_MAX (180) was knowledge-readers' TEXT_SNIPPET_MAX, and
//     equals the per-surface ContextBudget.maxExcerptChars ceiling (CB-2).
//   - MISTAKE_PROMPT_SNIPPET_MAX (160) was query-mistakes' PROMPT_SNIPPET_MAX,
//     a tool-local courtesy value that sits below the 180 budget ceiling.
export const KNOWLEDGE_EXCERPT_MAX = 180;
export const MISTAKE_PROMPT_SNIPPET_MAX = 160;

// ── P5.2 brief-refresh budget (BR-9) ────────────────────────────────────────
//
// Single tunable source for the activity-gated per-subject brief refresh
// (`docs/superpowers/specs/2026-05-31-p5.2-brief-refresh-design.md` §3.6).
// Same const/interface pattern as the ContextBudget surfaces above: a typed
// interface + one named const, no class/factory. These are the ONLY place the
// per-run and per-brief limits are defined — no per-file fallbacks (BR-9,
// acceptance §7 "single-source budgets").
export interface BriefRefreshBudget {
  /** Max subjects whose briefs refresh in a single nightly sweep run. When
   *  exceeded, prioritize by activity recency; defer remainder to the next
   *  night (no starvation). */
  maxSubjectsPerRun: number;
  /** Max recent activity events fed into a single subject brief's
   *  summarization. Formalizes the prior hardcoded `.limit(50)` in
   *  brief.ts loadEventsFromDb. */
  maxEventsPerBrief: number;
}

export const BRIEF_REFRESH_BUDGET: BriefRefreshBudget = {
  maxSubjectsPerRun: 12, // Never bites at today's 3–5 active subjects; forward-looking guard
  maxEventsPerBrief: 50, // Existing hardcoded limit in brief.ts loadEventsFromDb; proven bound
};
