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

import type { GateBiasConfig } from '@/server/proposals/adaptive-bias';
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
  // YUK-195 — question structure-correction surface falls back to the generic
  // budget until it needs an explicit one (no read-heavy fan-out; the 6 write
  // tools are local DB mutations).
  ingestion_block_edit: GENERIC_CONTEXT_BUDGET,
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

// ── P5.4-L2 proposal-feedback budget (AB-5) ─────────────────────────────────
//
// Single tunable source for the per-`(kind, relation)` accept-learned feedback
// digest injected into the Dreaming / Coach / Copilot prompts (adaptive-bias.ts
// `getProposalFeedbackDigest`). Same const+interface pattern as the
// ContextBudget surfaces and BriefRefreshBudget above: one typed interface + one
// named const, no class/factory. These are the ONLY place the digest caps are
// defined — no per-file fallbacks (acceptance §8 "single-source budget").
// Spec: docs/superpowers/specs/2026-05-31-p5.4-l2-adaptive-bias-design.md §3.1.
export interface ProposalFeedbackBudget {
  /** Max `(kind, relation)` cells surfaced to a prompt. Subsumes the prior
   *  Dreaming-local `DREAMING_ACCEPTANCE_RATE_TOP_N` (8) slice — the relation
   *  split means a single kind can fan out, so 12 keeps the proven kinds plus
   *  their relation breakdown without flooding. */
  maxKindRelations: number;
  /** Max recent `dismiss_reason` strings emitted per cell (only for net-negative
   *  cells, §3.1). */
  maxDismissReasonsPerCell: number;
  /** Max recent L1 `rubric_verdict.gate` strings emitted per edge cell (§3.1). */
  maxRubricGatesPerCell: number;
  /** PER-STRING truncation cap for a single dismiss-reason / gate string. 180
   *  aligns to the existing KNOWLEDGE_EXCERPT_MAX per-excerpt ceiling. NOTE: this
   *  is per-string ONLY — the whole-digest Copilot cap is `maxSerializedChars`. */
  maxChars: number;
  /** WHOLE-DIGEST serialized-JSON cap for the per-message Copilot read (AB-5 /
   *  codex#3): the ContextBudgetTracker gates only the tool-call loop, NOT
   *  initial-input chars, so Copilot truncates the serialized `proposal_feedback`
   *  to this at read time. Must hold several fully-populated edge cells — one cell
   *  serializes to ~240 chars, so reusing the 180 per-string `maxChars` here would
   *  collapse the feed to `[]` (P1 fix). */
  maxSerializedChars: number;
}

export const PROPOSAL_FEEDBACK_BUDGET: ProposalFeedbackBudget = {
  maxKindRelations: 12, // Subsumes the prior DREAMING_ACCEPTANCE_RATE_TOP_N (8) + relation fan-out
  maxDismissReasonsPerCell: 3, // A few representative recent reasons; not a full log
  maxRubricGatesPerCell: 3, // Recent machine gate failure modes per edge cell
  maxChars: 180, // per-string reason/gate cap (== KNOWLEDGE_EXCERPT_MAX)
  maxSerializedChars: 1200, // Copilot whole-digest read cap (~5 fully-populated edge cells); P1 fix
};

// ── P5.4-L2 gate-bias config (AB-3, §5 Q1) ──────────────────────────────────
//
// Single-source threshold + cold-start guard for `computeGateBump`. The
// `GateBiasConfig` TYPE is owned by adaptive-bias.ts (the L2 module, §3.4); this
// is the single-source CONST, kept here alongside PROPOSAL_FEEDBACK_BUDGET so
// all L2 tunables live in budgets.ts. Single-user scale: most `(kind, relation)`
// cells carry 0–5 samples, so `minSamples` keeps the bump inert until enough
// signal accrues (§6). Tune against real proposal_signals after a few weeks (the
// P5.1 "revisit after ~2 weeks of logs" stance).
export const PROPOSAL_GATE_BIAS_CONFIG: GateBiasConfig = {
  acceptanceThreshold: 0.3, // §5 Q1 suggested default
  minSamples: 5, // §5 Q1 suggested cold-start guard
};

// ── P5.3 long-term brief freshness/decay budget ─────────────────────────────
// Single tunable source for the long_term_md evidence-decay freshness score
// (docs/superpowers/specs/2026-05-31-p5.3-long-term-brief-stale-design.md §4).
// Pure arithmetic over SoT event.created_at — no LLM/embedding call.
export interface LongTermFreshnessBudget {
  /** Exponential decay half-life in days. freshness contribution of one
   *  evidence row = exp(-ln(2) * ageDays / halfLifeDays). 60d = balanced
   *  (readiness brief default): a 60d-old event contributes 0.5, 120d → 0.25. */
  halfLifeDays: number;
  /** ADVISORY render-annotation boundary: a stored score below this is the
   *  signal a render-time consumer uses to surface the paragraph as
   *  "may be dated". 0.3 = balanced default. NOT a mutation gate — nothing in
   *  the regen path acts on it; it only informs §7 surfacing. With halfLife 60d
   *  a single-event paragraph crosses 0.3 at ≈104d old. */
  freshnessThreshold: number;
}

export const LONG_TERM_FRESHNESS_BUDGET: LongTermFreshnessBudget = {
  halfLifeDays: 60,
  freshnessThreshold: 0.3,
};
