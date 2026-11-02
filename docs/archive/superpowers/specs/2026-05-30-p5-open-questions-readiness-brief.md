# Roadmap P5 — Design-Readiness Brief

> Status: EXPLORE-phase analysis. No spec, no code.
> Date: 2026-05-30 · Refs: YUK-143
> Source roadmap: `docs/planning/v0.4-complete-form-roadmap.md` §P5 (lines 858–880)

## 1. Purpose

The roadmap's **P5 section** ("Brainstorm 阶段 open question 待转 spec") lists eight open
questions that gate the Layer-8 **Global Copilot Orchestrator** (Phase 3) plus its supporting
infrastructure. These questions have sat in the brainstorm/open state and have **not been
converted to specs**. Each one still needs the **user's design decisions** before a writing-plan
or implementation can begin — that is the brainstorming gate.

This brief is the **EXPLORE-phase analysis** that precedes prioritized brainstorming. It:

- Consolidates the per-question research (problem / current-state / options / recommendation /
  user-decisions-needed / effort / Layer-8-criticality) so the user can read all eight in one
  place.
- Groups the questions by their role relative to the Layer-8 orchestrator.
- Recommends a **brainstorm → spec order**, noting dependencies, UI-vs-backend split, and which
  questions are already answered.

It is **not** a spec and makes **no** design decisions. Every "Recommendation" below is an
EXPLORE-phase suggestion to seed the brainstorm; the user owns the final call (per project
convention: architecture discussion happens at the feature level, and the brainstorming gate
must clear before a spec is written).

**How to use it:** read §2 for the per-question detail, jump to §3 for the prioritized order, then
pick one (or a small batch) from §4 to brainstorm in depth.

---

## 2. Per-question analysis (P5.1 – P5.8)

Each subsection carries: **Problem · Current state · Options · Recommendation · User decisions
needed · Effort · Layer-8 critical?**

### P5.1 — Context Budget Policy (single-user input bounding & tool read limits)

**Layer-8 critical: YES**

**Problem.** How many knowledge nodes/edges/events should Copilot, Dreaming, and Coach read per
turn, and what are the upper bounds for each batch operation? Today individual read tools have
**scattered per-parameter limits** (e.g. `query_mistakes` limit default 20 / max 50;
`expand_knowledge_subgraph` maxNodes default 30 / max 60; excerpt text capped 180 chars), but
there is **no unified policy** governing: (1) total context size per Copilot/Dreaming/Coach run
(nodes/edges/tokens); (2) whether per-tool limits should differ by surface; (3) how to prevent
agent input from becoming so large it distorts reasoning (context bloat → misread priorities);
(4) Dreaming batch upper bound (max proposals, max tool calls). Directly gates Layer-8 quality:
unbounded subgraphs or 100+ recent mistakes waste tokens on noise and bury signal.

**Current state.**
- Code: `src/server/ai/tools/knowledge-readers.ts` (TEXT_SNIPPET_MAX=180, MAX_NODES=60,
  RECENT_FAILURE_WINDOW_MS=30d); `query-mistakes.ts` (limit 1–50 default 20, PROMPT_SNIPPET_MAX=160);
  `query-events.ts` (limit 1–50 default 20, sinceDays max 180); `get-attempt-context.ts`
  (timelineLimit 1–50 default 25); `boss/handlers/dreaming_nightly.ts` (DREAMING_MAX_PROPOSALS=5,
  max_tool_calls=8 hardcoded in buildDreamingInput); `boss/handlers/coach_daily.ts`
  (COACH_MAX_PROPOSALS=5, max_tool_calls=12 hardcoded); `src/ai/registry.ts` (DEFAULT_BUDGET
  maxIterations=6, maxCost=0.5 — cost not enforced, only timeout/iterations); `allowlists.ts`
  (per-surface tool allowlist but no per-surface input budget).
- Docs: brainstorm `2026-05-17-agent-context-tools-docs.md` §4 lists P5.1 as brainstorm-only;
  spec `2026-05-17-agent-context-tools-design.md` §1–3 describes tool shapes/excerpts but defines
  no global bounds or per-surface read policy; v0.4 roadmap P5.1 flags it open, no decision.
- Missing: no unified `ContextBudget` type or per-surface bounding rule; no agent guidance for
  "am I over budget?"; no precedent for Copilot (user-facing, latency-sensitive) reading less than
  Dreaming (batch, latency-tolerant); no decision on excerpt length vs token cost (180 chars ≈ 45
  tokens/failure × 100 = 4500 tokens on one tool output).

**Options.**
- **A — Per-tool declarative budgets + aggregated assertion (conservative).** Each tool gets an
  explicit input max; runtime asserts accumulated outputs + new call stay under per-surface totals
  (e.g. Copilot ≤30 nodes, ≤500 events, ≤50 edges), rejecting over-budget calls before execute.
  + predictable/auditable, stateless per-call decision, strict guardrail. − hard to tune without
  live data; rejected high-value calls have no fallback signal; needs allowlist↔budget coordination.
- **B — Unified ContextBudget per surface + tool-level courtesy limits (adaptive).** Global
  `ContextBudget { maxNodes, maxEdges, maxEvents, maxTokens?, maxToolCalls }` per surface; each tool
  declares courtesy defaults overridable per call; runtime respects `min(tool.default, remaining)`,
  returns `{ applied_limit, budget_remaining }` metadata. + graceful degradation, easy per-surface
  tuning, agents can adjust strategy mid-run. − metadata bloat, over-requesting, state tracking
  across calls (error-prone if parallel/out-of-order).
- **C — Dreaming/Coach budget as spec constraint; Copilot as user-facing throttle (pragmatic).**
  Accept the existing tight Dreaming/Coach budgets; add a lightweight per-session Copilot budget
  (e.g. ≤4 tool calls/message, ≤100 nodes/edges, ≤120-char excerpts) held in chat state.
  + Dreaming/Coach already constrained & working; Copilot is real-time so user sees truncation; no
  new infra; single-user means Copilot latency/cost matters less than proposal quality.
  − inconsistent model (hardcoded vs config'd); Copilot budget unenforced if caller ignores it;
  doesn't solve high-bandwidth allowed tools (still needs per-tool courtesy limits).

**Recommendation (EXPLORE-phase): Option C.** Formalize Dreaming/Coach budgets as specs, add a
lightweight Copilot per-session throttle. Rationale: Dreaming (5/8) + Coach (5/12) are in prod and
working — document them as `DREAMING_CONTEXT_BUDGET` / `COACH_CONTEXT_BUDGET` so future tightening
is deliberate; Copilot is stateless per message so a per-message budget is natural; add per-tool
courtesy defaults (e.g. `queryKnowledgeTool` defaults limit=8); move hardcoded numbers into
`src/server/ai/tools/budgets.ts`. Incremental, unblocks Layer 8, allows post-hoc tuning from real
telemetry. Not a complete solution (no token accounting, no aggressive-agent guard).

**User decisions needed.**
1. Copilot max-context per user message? (suggested: 4 tool calls, 100 nodes/edges, 500 event rows,
   120-char excerpts — depends on acceptable latency on a single-user system).
2. Tighten Dreaming/Coach budgets? (suggested: keep as-is; collect ~2 weeks of dreaming_nightly logs
   to see if hitting the 8-tool-call ceiling).
3. Per-tool courtesy defaults user-configurable (profile settings) or code-only? (suggested: code-only
   v1, user config deferred).
4. Token-level accounting a hard requirement, or is node/edge/event counting sufficient? (suggested:
   count nodes/edges/events; token meter is T-PD4 backlog).

**Effort.** Backend-only, **~4–6 pts.** `budgets.ts` config (~1) · Copilot endpoint per-message
tracking + reject-over-limit (~2, needs StreamHandler state) · per-tool courtesy defaults +
`min(userRequest, budget)` (~1) · docs in `docs/modules/agent-tools.md` + spec (~1) · unit tests
(~1). No UI (Copilot streams, so truncation shows naturally).

---

### P5.2 — Subject-scoped vs global brief-note parallel refresh

**Layer-8 critical: YES**

**Problem.** Brief notes (`memory_brief_note`) are the Layer-7 memory consumed by Dreaming and
Coach. Should brief refresh be triggered **per-subject** (only when that subject is active) or
**globally** (always refresh all stale briefs)? And when multiple subject briefs need refresh, can
they run in **true parallel** without DB contention or state clobbering, given the current
singleton-dedup queue and serial `batchSize:1` handler? Gates Layer 8: Dreaming biases proposals
toward weak knowledge from briefs; Coach reads briefs for daily plans; North-Star goals
(YUK-143 / ADR-0025) are subject-scoped, implying concurrent briefs. Stale/missing briefs for
active subjects → agents lose context → ungrounded proposals.

**Current state.**
- Code: `memory_brief_note` table (schema.ts ~278–305: unique scope_key index, three prose
  sections, evidence ids, refreshed_at); `regenerateMemoryBrief()` (brief.ts ~153);
  `listStaleBriefScopes()` (brief.ts ~121, >24h); `enqueueBriefRegen()` (triggers.ts ~86, 6-min
  singleton dedup per scope_key); `buildMemoryBriefSweepHandler()` (triggers.ts ~152, daily 3:15
  BJT); `buildMemoryBriefRegenHandler()` (triggers.ts ~122, batchSize:1 serial). Dreaming reads
  briefs via `query_memory_brief` but does NOT trigger refresh; Coach has no refresh trigger.
- Missing: no per-subject-vs-global decision; no Dreaming/Coach integration with refresh; no
  parallel-safety analysis (singleton per scope_key but batchSize:1 serializes everything); no
  long_term stale rule (P5.3); no documented acceptance criteria.

**Options.**
- **A — Global always + per-subject on active goals.** Refresh `global` every 24h; refresh
  `subject:X` only if that subject has an active North-Star goal (YUK-143) or recent activity.
  + no wasted LLM calls on inactive subjects, scales, aligns with goal-scoped coaching.
  − couples goals/activity to refresh; cold start for new subjects; consumers must check freshness.
- **B — Deterministic per-subject + parallel batch.** Refresh all briefs daily on fixed cron, no
  activity coupling. + simple, predictable, no cold-start. − wastes LLM calls on inactive subjects,
  O(N) cost; needs batchSize>1 + verification that pg-boss doesn't serialize across scope_keys.
- **C — Hybrid lazy + smart expiry.** On-demand (Dreaming/Coach check staleness, enqueue if >24h)
  + periodic cleanup (nightly batch with batchSize:N). + no unused calls, fresh for active,
  scales. − read-time latency, complex error handling, event-ordering coordination.
- **D — Subject-scoped only (no global).** Global brief becomes a derived view. + simpler schema.
  − breaks `query_memory_brief(scope_key='global')`, loses global-learner view, needs domain rethink
  (ADR-0025 treats subjects + global goals as coexisting).

**Recommendation (EXPLORE-phase): Option A.** Minimum viable for the Layer-8 orchestrator: aligns
with subject-scoped North-Star goals, scales correctly for a single-user tool, keeps Dreaming/Coach
reading only fresh relevant briefs, parallel-safe with minimal change (keep singleton per scope_key,
bump handler batchSize to 2–3, verify pg-boss runs subject:A and subject:B concurrently). Daily cron
enqueues `global` + active-goal subjects, with a >48h safety-valve fallback. Dreaming/Coach assume
cron-maintained freshness (don't block on refresh); failed refresh logs and leaves old brief.
Reject B (wastes budget), C (too much latency/complexity for single-user), D (loses global view).

**User decisions needed.**
- Tie refresh to active North-Star goals (A) or refresh deterministically daily (B)? (affects
  YUK-143 roadmap + brief-goal coupling).
- Is parallel refresh required, or is serial (batchSize:1) acceptable? (queue tuning + contention).
- Should Dreaming proactively trigger refresh before reading, or is nightly cron freshness enough?
- Long-term stale rule (P5.3): 30d / 90d / after N days without new evidence?

**Effort.** Backend-only, **2–3 pts.** Activity query (join active_goals + optional recent activity,
~1) · cron filter/order (~0.5) · parallel-safety check + concurrent-refresh test (~0.5) · E2E
"Dreaming reads fresh brief after refresh" (~1) · ADR/module-spec docs (~0.5). No pre-flight.
**Blocking:** T-D6 Coach and T-D5 Drawer assume reasonably fresh briefs — undefined refresh blocks
their behavior specs.

---

### P5.3 — Long-term brief paragraph stale rules

**Layer-8 critical: YES**

**Problem.** The brief system (ADR-0015 §2 + ADR-0017) defines three time windows per scope_key:
`recent_week_md` / `recent_months_md` / `long_term_md`. recent_week and recent_months are
time-bounded (7d, 3mo) but `long_term` has **no staleness/eviction rules**: when should a long-term
claim be considered stale and demoted/removed as supporting evidence ages? Without staleness
semantics, long-term briefs risk encoding outdated claims that the orchestrator reads as fresh
ground truth. Dreaming (T-DR) and the Copilot drawer (Layer 8) both consume brief text directly,
so staleness directly affects proposal quality.

**Current state.**
- Existing: ADR-0017 cron daily sweep (`refreshed_at IS NULL OR < now()-24h`); anti-storm dedup
  (pg-boss singletonKey 6-min + SoT diff threshold); `memory_brief_note` schema (schema.ts ~257–282)
  has `refreshed_at` + `latest_evidence_at` + `evidence_count`; T-37 brief-writer-driver plan
  explicitly defers "long-term stale rules (v0.4 §6 P5 brainstorm spec)" out of Wave 1; brainstorm
  doc frames the question ("how long without evidence before a long-term paragraph is demoted/removed?").
- Missing: definition of "evidence age" (latest vs median/modal evidence ts); "how stale is too
  stale" (30/90/180d? per scope_key?); remediation (remove / demote-to-footnote / flag for review /
  re-verify); evidence weighting (recent overrides old? conflicting = signal?); reset semantics on
  re-confirmation; cost/frequency model (every regen vs separate cadence).

**Options.**
- **A — Timestamp-based eviction (simplest).** Track `latest_evidence_ts`; if `now() - ts >
  threshold` (~90d), exclude from `long_term_md`, archive to a JSONB column. + stateless,
  deterministic, auditable. − rigid (can't tell strong-old from noise), loses context, needs tuning;
  risk of confusing sudden memory gaps.
- **B — Evidence decay + scoring (signals-aware).** `freshness_score = sum(time_decay(evidence_ts))
  / count`, `time_decay(t)=exp(-t/half_life)`; below threshold (~0.3) demote to footnote with
  metadata (age, supporting events, recent count); include demotion reason so Copilot can explain.
  + nuanced, transparent, evidence-quality-aware. − more LLM cost, schema columns, half-life/threshold
  tuning, verbosity risk.
- **C — Lazy staleness + human-in-the-loop (conservative).** No auto-evict; mark "(last confirmed
  90+ days ago)" in-line; on render/proposal-gen optionally suggest a re-verify task or inject a
  soft prompt hint. + no info loss, transparent, user agency. − burden on user/Copilot, brief
  doesn't shrink, stale claims accumulate silently (user rarely reviews own brief).

**Recommendation (EXPLORE-phase): Option B (with a pragmatic simplification).** A is too rigid for
a learning system (one high-quality event can stay true for years); C is too passive (stale briefs
accumulate). B balances clarity + automation + ADR-0017's evidence_ids-as-SoT commitment.
Ready-to-code shape: decay `freshness = sum(exp(-days/60)) / max(1, count)` (half-life 60d,
configurable `LONG_TERM_HALF_LIFE_DAYS`); threshold <0.3 → "stale-but-valid", archive to
`long_term_stale_claims` JSONB; brief template splits "Memory (updated recently)" vs "Earlier
patterns (may be dated)"; re-check every regen (reuse already-fetched evidence_ids, no new LLM call);
Phase-C per-prefix override. Defer: explicit re-verification task, per-evidence confidence weighting,
cost tiering. Unblocks Layer 8 (Dreaming cites without stale-as-truth risk; drawer distinguishes
fresh vs dated; brief self-annotates staleness).

**User decisions needed.**
- Half-life (days): 30 (aggressive) / 60 (balanced) / 90 (conservative) / scope-key configurable?
- Staleness threshold (freshness_score): 0.2 / 0.3 / 0.5?
- Remediation UX: separate section with metadata vs removed entirely vs footnoted?
- Scope-key override (uniform vs per-prefix, e.g. `mistake_cluster:*` aggressive, `subject:math`
  conservative — costs ~4pt in Phase C)?
- Does the rule apply to `meta:orchestrator_self` (procedural memory)?
- What qualifies as "evidence" — only SoT ids in `evidence_ids[]`, or do Mem0 facts count? (ADR-0017
  keeps namespaces separate → current answer "SoT ids only"; confirm.)

**Effort.** **8–13 pts, backend-only, important for brief quality but not on the Layer-8 critical
path.** Decision/template (~0.5) · schema `long_term_stale_claims JSONB` + `long_term_freshness_score
DECIMAL` migration (~1) · regen logic: decay + filter + archive + re-template (~4) · tests (~3) ·
optional Phase-C scope-key override + UI stale section (+4–5). Recommended placement: Phase 1.5
(between Wave 1 completion and T-DR Dreaming lane start) so freshness is guaranteed before Dreaming
consumes briefs; if deferred → Phase C (acceptable, brief quality suffers until then).

---

### P5.4 — Proposal Quality Rubric enforcement

**Layer-8 critical: YES**

**Problem.** The proposal quality rubric is **documented in `docs/modules/knowledge.md` §4 but NOT
enforced in code**. Documented: 7 universal structural gates (§4.1), evidence levels strong/medium/
weak with relation-specific thresholds (§4.2), relation-specific gates (§4.3). Implemented: only
~3 structural gates. Missing: evidence-level validation, relation-specific gates, reasoning-depth
checks, agent-vs-user proposal distinction. Impact: Dreaming/Coach can propose low-quality edges
(same-name siblings as `contrasts_with` with zero evidence; `related_to` as a dumping ground)
because there is no validator between LLM output and `writeAiProposal()`. The inbox shows these;
dismissal gives no feedback to tighten agent behavior. All Layer-8 agents feed this same broken path.

**Current state.**
- Code: `proposal-tools.ts` (~230–330) `proposeKnowledgeEdgeExecute()` validates 5 gates (self-edge,
  unknown_node, cross_subject, duplicate_live_edge, duplicate_pending, parent_semantic_duplicate) —
  no evidence-level / relation-specific gates; `review.ts` (~160–187) `checkProposalGate()` does
  cooldown/duplicate-pending only; `validate.ts` only `assertKnowledgeIdsExist()`; `writer.ts`
  (~88–127) `writeAiProposal()` accepts payload as-is, no pre-write validation; `proposal.ts` Zod
  shape only.
- Documented-but-not-enforced (knowledge.md §4): evidence levels; relation gates (`prerequisite`,
  `contrasts_with`, `applied_in`, `related_to`); reasoning depth (concrete + linked refs vs generic);
  `evidence_event_ids` is in schema but optional/defaults `[]`, no validation enforces it.
- Missing from code: evidence validator (recency + judge metadata), relation-specific gate logic,
  reasoning-depth checker, evidence-level calculator, agent-vs-user distinction (both routes share
  one write path today).

**Options.**
- **A — Inline validation in proposeKnowledgeEdgeTool (minimal).** + no new schema/table. − ~80 lines
  in proposal-tools.ts mixing validation with dispatch, harder to test, agent/user distinction buried;
  does NOT gate the legacy `write_proposal` MCP path in review.ts (stays permissive).
- **B — New RubricValidator service + reusable gate in writer layer (recommended).**
  `src/server/knowledge/rubric-validator.ts` exports `validateProposalQuality(payload, db, context)
  → { ok, reason }`, called by both proposal-tools.ts and review.ts so DomainTool + legacy MCP both
  enforce. Testable without agent runtime. − ~150–200 lines + a context param `{ isAgent, actorRef }`
  + small per-proposal DB reads.
- **C — Schema-level validation + evidence gateway (strictest).** Move checks into Zod (e.g.
  `evidence_event_ids.min(1)` for agents). − needs conditional-required (Zod can't express cleanly),
  schema churn; overkill for single-user.

**Recommendation (EXPLORE-phase): Option B.** Create `rubric-validator.ts` (~180 lines) running the
7 universal gates + (if isAgent) evidence non-empty / ≥1 event / ≤30d old + relation-specific gate;
returns `{ ok } | { ok:false; gate; reason }`. Call it in both `proposeKnowledgeEdgeExecute()` and
`writeProposalAfterGate()`; skip for user-manually-edited proposals (rubric is agent-only per §4
intent). No schema changes (runtime-require `evidence_event_ids` for agents). B over A (reaches the
legacy MCP path where Dreaming routes) and over C (no schema churn).

**User decisions needed.**
- Different rubrics for agent vs user-edited proposals? (draft: agents strict, users loose but pass
  structural guards — §4).
- Evidence window: 30 days or configurable?
- For `prerequisite`/`contrasts_with`: is explicit judge analysis sufficient alone, or also accept
  user notes? (draft: either, per review.ts ~70).
- On reject: silent skip (`status='skipped:rubric_gate'`) or write error log for agent debugging?
  (draft: skip + return reason in tool output).
- Relation-specific gates: start with `prerequisite` + `contrasts_with`, or all 5? (draft: implement
  all 5 per §4.3, begin testing with wenyan — highest `contrasts_with` overuse risk).
- Evidence "strong" vs "medium": reject at validation or downweight in inbox? (draft: reject agent
  proposals at medium/weak; user edits bypass).

**Effort.** Backend-only, **~250–300 lines** (180 validator + 50–70 call sites + tests). Not
pre-flight-gated (pure validation service; output flows through existing inbox lifecycle). Testable
by mocking db + context; fixtures exist (knowledge.md §5).

---

### P5.5 — Tool Eval Fixtures

**Layer-8 critical: YES**

**Problem.** Build comprehensive, scenario-driven test fixtures for the **21-member DomainTool
suite**. Roadmap: "10 fixed questions listed but only the knowledge fixture landed." Gates Layer-8
readiness — Copilot Drawer, Dreaming, Coach, and Knowledge Maintenance all rely on these tools to
answer concrete learner-context questions. Without fixtures it is impossible to verify tool outputs
are **intelligible to agents** (not merely that SQL returns rows) or that tool-agent interaction
produces coherent proposals. Tool implementations exist (~21 across read/propose/write) but lack
scenario-grounded coverage that validates semantic understanding. The 10 fixed questions
(`knowledge.md §5`) define the target; only the wenyan knowledge-graph fixture is complete; the
remaining 9 (mistake/review/record/learning-item/memory/proposal scenarios) have no harness.

**Current state.**
- Implemented (2026-05-30): 21 DomainTools registered (`bootstrap.ts` ~41–65) across
  knowledge-readers / context-readers / query-mistakes / get-attempt-context / query-events /
  proposal-tools; knowledge fixture baseline `read-tools-m2.test.ts` (seeds k_root/k_zhi/k_er +
  contrasts_with edge; tests getSubjectGraphOverview / queryKnowledge / expandKnowledgeSubgraph /
  findKnowledgePaths); UI skeleton `copilot-tool-fixtures.ts` (~18–61, 6 static JSON stubs); all 10
  fixture questions listed in `knowledge.md §5` (~365–376).
- Missing: dedicated harness for the other 9 scenarios; E2E chained-tool tests (query_mistakes →
  attribute_mistake → propose_variant → propose_knowledge_edge); test corpus for
  math/English/programming/reading-note (only wenyan graph exists; P5.8 = "5 complete fixtures");
  agent-readable-output validation; cost/perf instrumentation in the test harness.

**Options.**
- **A — Minimal suite (4 scenarios, core paths).** query_mistakes+get_attempt_context, knowledge-edge
  proposal+duplicate rejection, review_due, learning_item_context+completion. ~60% of surface; leaves
  variant/memory-brief/record-linking unverified. ~2–3 days. Validates Layer-8 critical path without
  full coverage.
- **B — Complete suite (all 10 scenarios, multi-tool chains).** End-to-end harness, all 5 subjects,
  cost instrumentation, agent-readability assertions. ~6–8 days. Prereq: subject-graph seed (may need
  P5.8). Highest confidence.
- **C — Lazy / fixtures-on-demand.** Build incrementally per real agent task; each task pre-flight
  adds one fixture. Flexible by use case. − delayed validation, integration bugs surface late; bad
  for pre-flight gating.

**Recommendation (EXPLORE-phase): Option B with phased sequencing.** Phase 1 (~2–3d): 4 core
fixtures that unblock Copilot Drawer + Coach (mistake-confusion chain; zero-result-corrective;
knowledge-edge-duplicate rejection; learning-item-context + completion). Phase 2 (~3–4d, after
subject-graph seeding): remaining 6 (review_due, record-linking, variant gen, memory-brief query,
learning-intent, edge-prerequisite). B over A/C: Layer-8 agents can't be validated as human-usable
without proof outputs are agent-readable; fixtures become source-of-truth for tool-contract
evolution and living spec; 6–8 days to de-risk downstream Copilot/agent work is net-positive. A is
acceptable as a minimum viable gate under timeline pressure with Phase 2 following immediately.

**User decisions needed.**
- One batch or two phases (4 core + 6 advanced)? (depends on subject-graph seed timeline + drawer
  launch readiness).
- Subject coverage: Phase 1 wenyan only; Phase 2 priority order (math > English > programming >
  reading-note, or different)?
- Scope boundary: happy-path + known errors only, or also malformed-input recovery / permission /
  rate-limit?
- Agent-readability assertion contract: what does "agent understands context" mean in code (key
  insight labels present? evidence_event_ids resolvable? no nulls in critical fields)?
- Multi-tool chain testing: validate sequencing, or test each tool isolated and trust SDK integration
  tests?
- Cost instrumentation: assert costLabel/costDetail accuracy, or leave to perf suite?
- Maintenance ownership: fixture-evolution SLA when tool APIs change?

**Effort.** Backend-only (server test layer). **Option A 2–3 person-days** (~600 lines, reuse db
reset/seed, new `fixtures.test.ts`). **Option B 6–8 person-days** (Phase 1 ~2–3d + Phase 2 ~3–4d;
Phase 2 blocked by subject-graph seeding — math/English/programming/reading-note corpus). ~500ms per
scenario. No UI required (copilot-tool-fixtures.ts already exists as static stubs).

---

### P5.6 — Copilot suggestion semantics: proactive vs corrective vs accept_suggestion

**Layer-8 critical: YES**

**Problem.** ADR-0011 v2 (2026-05-16) defined `AcceptSuggestionChip` with a `suggestion_kind`
discriminator ('proactive' | 'corrective'), but the semantics are **underspecified operationally**.
Given three overlapping signal paths (proactive agent suggestions, corrective agent suggestions, the
`accept_suggestion` action): what are the exact trigger rules, KPI implications, and flow boundaries?
Specifically — when does Coach/Copilot emit proactive vs corrective chips? How do they feed
ranking/acceptance-rate KPI (ADR-0011 v2 §2.1: corrective "不计入接受率" — but what triggers that
rule)? What's the relationship between `AiProposalPayload` kinds (inbox) and `AcceptSuggestionChip`
(drawer interaction)? Layer-8 critical: the Phase-3 orchestrator's "proactive partner" intent
depends on unambiguous suggestion routing.

**Current state.**
- Code (shipped 2026-05-29 v1 closeout): `event/known.ts` (~324–350) `SuggestionKind` enum,
  `AcceptSuggestionChip` payload (`suggestion_kind`, `chip_label`, `target_tool?`, `target_args?`,
  `source_event_id`); event schema locked, tests confirm parse. UI: `SuggestionKindTag.tsx` renders
  "修正" badge for corrective with "不计入接受率" tooltip; `TeachingDrawer.tsx` hardcoded mixed-kind
  suggestion array. Coach (`coach.ts` + `coach_daily.ts`): `TodayPlan` has plan_adjustments /
  maintenance_proposals / goal_strand; writes via `AiProposalPayload` (14 kinds); **does NOT emit
  `AcceptSuggestionChip` directly** — produces `experimental:proposal` events for the inbox, user
  rates separately. Inbox reads `proposal` table grouped by kind, **no proposal → suggestion_kind
  mapping**. ADR-0011 §2.1 defines the semantic table (proactive=agent success → next-step chip;
  corrective=tool_use failure/result_count=0 → retry chip) but **no handler spec / event hook doc**.
- Missing: no `writeAcceptSuggestionChip()` or explicit chip-emit call; no proposal → suggestion_kind
  coercion; no metrics layer that reads suggestion_kind to suppress KPI for corrective; design brief
  v2.1 hot-spot #5 ("soft-fail corrective chip '扩到 90 天再查' running acceptSuggestion — is the
  accept_suggestion semantic right, or another action?") still unresolved.

**Options.**
- **A — Semantic signals (tight coupling to source event).** Infer suggestion_kind from whether the
  source was a successful explain vs failed tool_use (via source_event_id / Coach run state).
  + no new structure, deterministic from event chain. − implicit rule in handler code (not schema),
  needs proposal↔event join at accept-time, risky to refactor, unclear default when no source event.
- **B — Explicit field in proposal payload (loose coupling, forward-compatible).** Extend
  `AiProposalPayload` base with optional `suggestion_kind`; Coach/Copilot set it at write-time;
  at accept, read directly. + clear at write, no inference, documents intent, easy filter, explicit
  fixtures. − ~15 proposal kinds need a schema audit (do all make sense?), Coach must be primed,
  author cognitive load.
- **C — Separate event path (deferred to v0.5).** Don't conflate into one `accept_suggestion`; emit
  `accept_suggestion` (proactive, counts) and `accept_correction` (corrective, excluded). + cleanest
  separation, trivial KPI filter. − more KnownEvent kinds, possible UI confusion; ADR-0011 v2 was
  signed off with `suggestion_kind`, so changing the action now needs an erratum.

**Recommendation (EXPLORE-phase): Option B.** Explicit at write, direct field read at accept (no
event-chain traversal); trivially testable; evolvable (add to only the kinds that need it — `defer`,
`plan_adjustment`, maybe `relearn` — not `knowledge_edge`); fits Layer-8 (Coach/Copilot already call
`writeAiProposal`); resolves hot-spot #5 (corrective chip tags proposal `suggestion_kind='corrective'`
→ accept event carries the tag → KPI filters). Concrete points: extend `BaseProposal` (proposal.ts
~47) with optional `suggestion_kind`; update `COACH_DAILY_OBJECTIVE` (coach_daily.ts ~36) to prime
corrective on soft-fail; add a corrective Coach test fixture; update proposal-accept handler
(actions.ts) to pass it into `AcceptSuggestionChip.payload`; KPI metric filters out corrective.

**User decisions needed.**
1. `suggestion_kind` on ALL 14 proposal kinds or a subset (plan_adjustment / defer / relearn)? If
   subset, which?
2. Acceptance-rate KPI definition: total accept_suggestion events, or minus corrective? (ADR-0011 §2.1
   implies minus, needs product spec).
3. Coach model primed to emit suggestion_kind in output JSON, or post-process inference in
   `runCoach()`?
4. TeachingDrawer hardcoded suggestions: always-proactive by definition, or can be corrective (e.g.
   after N failed attempts)?

**Effort.** Backend-only, **~3–4 days** (no UI for MVP — SuggestionKindTag already renders). Schema
audit + extension (0.5d) · Coach priming + fixture (1d) · handler proposal→accept_suggestion (0.5d) ·
KPI metric wiring (0.5d) · E2E Coach→proposal→accept→KPI (1d) · ADR-0011 erratum (0.5d). No pre-flight
gates (additive optional field, no new schema/UI).

---

### P5.7 — `experimental:tool_use` → KnownEvent promotion criteria

**Layer-8 critical: YES — but ALREADY ANSWERED / SHIPPED**

**Problem.** v0.4 roadmap open question (line 878): the stabilization criteria to promote
`experimental:tool_use` from the experimental namespace to a first-class `KnownEvent`. Was blocking
the Layer-8 full lifecycle (tool-use mirroring underpins audit trail + cost tracking + proposal
causality). Required settling: (1) how many real tools before schema is stable, (2) how long payload
shape must remain unchanged, (3) what design-validation gates must pass before promotion is safe.

**Current state — SHIPPED (2026-05-28, T-D7 / YUK-126).**
- Schema (`event/known.ts`): `ToolUseExperimental` → `ToolUseQuery` (KnownEvent branch; action
  `'experimental:tool_use'` → `'tool_use'`; payload unchanged; discriminated by
  `action:literal('tool_use')` + `subject_kind:literal('query')`). *(Verified in worktree:
  `known.ts` ~416–430 carries ToolUseQuery with the §1.1 promotion note; mcp-bridge.ts ~210 writes
  `action: 'tool_use'`.)*
- DB migration (`drizzle/0019_promote_tool_use.sql`): DML-only `UPDATE event SET action='tool_use'
  WHERE action='experimental:tool_use'`, no DDL.
- Code sweep (6 files): experimental.ts (removed export + RESERVED entry), event/index.ts
  (14-branch KnownEvent), mcp-bridge.ts (mirror writer + comments), types.ts (policy comments),
  event.test.ts (8 cases renamed; reserved-action test → `experimental:user_cause`), plus
  mcp-bridge tests / scope_tagger / events queries / ai README.
- Stabilization evidence (ADR-0011 §1.1): ≥3 tools (13+ read + 8 propose/write, far exceeds) · v2.1
  design shipped (Wave 5 T-D3, PR #179) · payload stable since YUK-82 (12 days) · user explicitly
  waived the 2-week stability window 2026-05-28 (shape substantively proven; ≥3-tools precondition
  met); quality gates NOT waived, all green at ship.
- Deferred experimental actions: `experimental:copilot_user_ask`, `experimental:copilot_chip_trigger`
  (Wave 5 T-D3/C, not yet ADR-catalogued, deferred to Wave 7+); `experimental:user_cause`,
  `experimental:record_capture`, `experimental:memory_brief_refresh` (dedicated schemas, own criteria).
- No pending spec work: ADR-0011 §1.1 fully documents decision + criteria + diff. The question is ANSWERED.

**Options.**
- **A — Retrospective documentation (DONE).** Promotion shipped; ADR-0011 §1.1 + master-roadmap §5.1
  Wave 6 + status.md Wave 6 cover it. Optionally write a reusable `experimental-promotion-gate`
  pattern doc to codify the criteria for future P5.x promotions. Low cost, gives future promotions a
  playbook.
- **B — Two-stage future promotion (remaining experimental actions).** Promote the two copilot
  actions together in Wave 7+ as an ADR-0011 erratum (tightly coupled T-D3/C contract) vs per-action
  tickets. Recommend erratum (faster batch).
- **C — Governance framework (forward-looking).** Codify the gate as a checkdown in CLAUDE.md Layer-8
  section or a `/experimental-promote-checklist` skill: (≥3 tools OR design ship) AND (payload stable
  2+ weeks OR user override w/ reason) AND (quality gates green). ~1–2 hrs.

**Recommendation (EXPLORE-phase): A + B + light C, sequential.** (1) Immediate: acknowledge P5.7 is
answered/shipped — ADR-0011 §1.1 is the spec, no design work. (2) Wave 7: batch-promote
`copilot_user_ask` + `copilot_chip_trigger` via ADR-0011 erratum (T-D7b, ~2 pts) — record payload
schema + criteria, update RESERVED_EXPERIMENTAL_ACTIONS, DML + sweep. (3) Post-Wave 7: write
`docs/design/experimental-promotion-gate.md` (~500 words) — criteria template, process checklist,
erratum-vs-standalone matrix, historical record. Turns P5.7 from ad-hoc question into reusable
architectural guidance.

**User decisions needed.**
- Confirm: is the T-D7 promotion the final answer to P5.7, or revisit criteria for future
  experimental actions?
- Wave 7 T-D7b scope: promote copilot actions together (erratum) or separately (per-action tickets)?
- Documentation: codify the experimental→stable pattern (docs/design + CLAUDE.md note + skill), or
  leave it as implicit ADR-0011 precedent?

**Effort.** tool_use promotion **SHIPPED** (3 pts, Wave 6, 6-file sweep + DML + ADR §1.1, backend-only).
Copilot action promotion (Wave 7 T-D7b, pending) **~2 pts** (similar 2-action sweep + DML + erratum).
Promotion-gate pattern doc (optional, post-Wave 7) **~1 pt** (500-word doc + CLAUDE.md + optional skill
scaffold, docs-only).

---

### P5.8 — Five complete subject evaluation fixtures (wenyan / math / English / programming / reading-note)

**Layer-8 critical: NO (eval-fixtures track; gates framework-generality validation, not the orchestrator directly)**

**Problem.** Build the remaining subject eval fixtures after math. Only math has a complete, tested
fixture (10 items + E2E acid test). Wenyan, English, programming, reading-note lack: (1) fixture
schema definitions, (2) data files (JSON), (3) test suites validating structure, (4) E2E smoke tests
through judge/assessment. Needed to validate the generalized framework (Foundation A/B/C) works
across diverse subject semantics, judge routes, and question kinds.

**Current state.**
- Math: complete (✅). `src/subjects/math/fixtures/index.ts` (shared + derivation schemas) + data.json
  (10 single-choice) + derivation-data.json + tests (index, e2e.smoke, derivation.e2e). *(Verified in
  worktree: the math fixtures directory exists with data + derivation + e2e tests.)*
- Physics: partial (P0/P1/P2). `src/subjects/physics/fixtures/index.ts` (10 unit-dimension items) +
  data.json + tests (e2e.smoke, schema).
- Wenyan / English / programming / reading-note: **missing entirely**. No
  `src/subjects/{wenyan,english,programming,reading}/fixtures/` directories. *(Verified: wenyan has
  no fixtures directory.)* Wenyan has a profile (`src/subjects/wenyan/profile.ts`, ~116 lines:
  question kinds single_choice / multiple_choice / short_answer / translation / reading_comprehension;
  judge capabilities exact / keyword / semantic). English/programming mentioned in v0.3 roadmap as
  future subjects, no code presence. Reading-note unclear (may be a fixture category, not a subject).

**Options.**
- **A — Wenyan only (1 subject); defer English/programming/reading-note.** Leverages existing profile +
  framework; tests semantic judge route on a real subject. ~low effort, unblocks wenyan teaching-flow
  validation. − reading-note ambiguity may block if it's a critical category.
- **B — All 5 (incl. extended math derivations).** Most comprehensive, but 3 of 5 lack profiles /
  question-kind clarity / judge-route strategy. English (grammar/translation, semantic) straightforward;
  programming needs code_execution judge (not implemented); reading-note undefined. ~very high effort
  (English/programming profiles + code_execution stub + reading-note clarity). Risk: shipping incomplete
  judge capabilities blocks real assessment.
- **C — Wenyan + English (2 subjects); stub programming + reading-note.** Covers semantic route fully
  (wenyan + English). Programming stub compiles; reading-note defined as a fixture category. ~medium.
  − stubs don't test code_execution, so programming pressure is hollow.

**Recommendation (EXPLORE-phase): Option A.** Build wenyan only next, deferring the others to a later
clarification session. Wenyan has a complete validated profile, exercises the semantic judge route
(translation / reading_comprehension — the next validation frontier after exact/keyword and physics
unit_dimension), ships at low effort with high framework pressure (5–10 items). English/programming are
blocked on profile design + judge-capability decisions (English grammar route; programming
code_execution). Reading-note is semantically unclear (likely a fixture *type* for the Living Note
system, not a subject) — needs product-owner clarification before building. Ship wenyan as the
proof-of-concept for the remaining 3.

**User decisions needed.**
- Product clarification: is P5.8 asking for 5 *subject* fixtures or 5 *fixture types*? The roadmap text
  ("wenyan / math / English / programming / reading note") is only 5 items if reading-note is a subject;
  if it's a category (Living Note artifact vs knowledge graph), scope changes entirely.
- English strategy: (a) SubjectProfile like math/wenyan/physics, or special case? (b) judge routes —
  semantic only, or also exact for grammar-rule Q&A? (c) core question kinds?
- Programming strategy: (a) stub code_execution with an expected-output schema, or wait until it exists?
  (b) code-tracing (short-answer) vs real submission + test feedback? (c) languages?
- Reading-note intent: evaluate the Living Note system vs reference rubric, or build
  reading-comprehension question fixtures? (former = Artifact-layer pipeline, not a subject fixture).

**Effort.** **Wenyan only (Rec A): ~1–2 days** (schema ~40 lines like physics/math; data.json 10–12
items: 5 single_choice + 3–4 translation + 2–3 reading_comprehension grounded in classical texts;
index.test.ts; e2e.smoke.test.ts routing to semantic judge — backend-only). **All 5 (B): ~4–6 days**
(adds English profile + fixture, programming stub/profile decision, reading-note clarification, plus
cross-subject validation; high risk from incomplete code_execution). **Wenyan + English (C): ~2–3 days.**

---

## 3. Prioritization + sequencing

### Grouping

**(a) Layer-8-Copilot-critical — gates the Global Copilot Orchestrator**

| # | Question | Status | UI? | Effort |
|---|----------|--------|-----|--------|
| P5.7 | tool_use → KnownEvent promotion | **SHIPPED** (ADR-0011 §1.1) | No | done (follow-ups ~2–3 pts) |
| P5.1 | Context Budget Policy | open | No | 4–6 pts |
| P5.2 | Subject-scoped vs global brief refresh | open | No | 2–3 pts |
| P5.4 | Proposal Quality Rubric enforcement | open | No | ~250–300 lines |
| P5.6 | Copilot suggestion semantics | open | No (UI shipped) | 3–4 days |
| P5.3 | Long-term brief stale rules | open | No (opt. Phase-C UI) | 8–13 pts |

**(b) Supporting infra** — P5.2, P5.3 also live here: they are the **brief-freshness substrate**
the orchestrator reads. P5.2 (refresh strategy) is the prerequisite; P5.3 (long-term staleness) is
the quality layer on top. Neither needs UI for the core spec.

**(c) Eval fixtures**

| # | Question | Status | Layer-8 critical | Effort |
|---|----------|--------|------------------|--------|
| P5.5 | Tool Eval Fixtures (21-tool suite) | open | Yes | 2–8 days (phased) |
| P5.8 | 5 subject eval fixtures | partial (math + physics done) | No | 1–6 days (Option A: ~1–2d) |

### Dependencies

- **P5.7 is done** — drop it from the brainstorm queue; the only remaining work is the Wave-7 copilot-action
  errata + an optional pattern doc, both already scoped. No user design decision required beyond a
  confirm.
- **P5.2 → P5.3:** brief *refresh strategy* must be settled before *long-term staleness rules* — staleness
  semantics ride on the regen cycle P5.2 defines. P5.3's recommended placement (Phase 1.5) is explicitly
  "after refresh policy is set, before Dreaming consumes briefs."
- **P5.4 is standalone:** pure validation service, no dependency on the brief layer; can brainstorm/spec
  independently and in parallel with the brief work.
- **P5.1 is standalone-ish:** the budget config touches every agent surface but depends on no other P5
  question; it does interact with P5.5 (fixtures should exercise budget enforcement once it exists).
- **P5.5 Phase 2 → P5.8:** the complete tool-eval suite needs subject-graph seed data; P5.8's wenyan (and
  later subjects) supply that corpus. So **P5.8 wenyan unblocks P5.5 Phase 2.** P5.5 Phase 1 (wenyan-only)
  is independent and can start now.
- **P5.6 schema is shipped** (`SuggestionKind`, `AcceptSuggestionChip`); the open work is handler + KPI
  wiring + an additive optional proposal field — no new schema/UI, no pre-flight gate.

### UI vs backend-only

Every P5 question's **core spec is backend-only.** No pre-flight design-doc gate is required to brainstorm
or spec any of them:
- P5.1, P5.2, P5.4, P5.5, P5.7 — fully backend; Copilot streams so truncation is visible without UI work.
- P5.6 — backend-only for MVP (SuggestionKindTag UI already shipped).
- P5.3 — backend-only core; an *optional* Phase-C "stale section" rendering would later need the UI
  pre-flight, but that's out of the v1 spec scope.
- P5.8 — backend-only (server test layer).

So the UI design-doc pre-flight gate does **not** block any of this work; it would only attach to the
deferred Phase-C P5.3 stale-section rendering if/when that is pursued.

### Recommended brainstorm → spec order

1. **P5.1 — Context Budget Policy** *(first; smallest decision surface, unblocks all agents, no deps).*
   Pragmatic Option C decisions are mostly "confirm the suggested numbers." Settling it first means every
   later agent spec (P5.4 validator, P5.5 fixtures, P5.6 Coach priming) writes against a known budget.

2. **P5.2 — Brief refresh strategy** *(brief substrate, prerequisite for P5.3, blocks T-D5/T-D6 specs).*
   Decide Option A vs B and the parallel-safety question; small (2–3 pts) and unblocks Coach/Drawer
   behavior specs.

3. **P5.4 — Proposal Quality Rubric enforcement** *(can run in parallel with P5.2; standalone).*
   Highest direct quality lever on agent output; the rubric is already written in `knowledge.md §4`, so
   brainstorming is mostly scoping (agent-vs-user, which relation gates, reject-vs-downweight).

4. **P5.6 — Copilot suggestion semantics** *(after P5.4; both touch the proposal write path).*
   Resolves hot-spot #5 and the acceptance-rate KPI definition. Schema is shipped; brainstorm is product
   semantics (KPI definition, which proposal kinds carry suggestion_kind).

5. **P5.5 Phase 1 — core tool eval fixtures** *(can start once P5.1 budget is set; wenyan-only, no seed
   dep).* Validates the Layer-8 critical path (Drawer + Coach) and exercises P5.1 budget + P5.4 rubric.

6. **P5.8 wenyan fixture** *(Option A; unblocks P5.5 Phase 2 by supplying subject-graph corpus; needs a
   product clarification on the "5 subjects vs 5 types" question first).*

7. **P5.3 — Long-term brief stale rules** *(after P5.2; Phase 1.5 placement; largest at 8–13 pts).*
   Quality layer on the refresh cycle; brainstorm the half-life / threshold / remediation-UX decisions.

8. **P5.5 Phase 2 + later P5.8 subjects** *(after wenyan corpus lands; English/programming/reading-note
   blocked on profile + judge-capability + product clarifications).*

**P5.7:** out of the brainstorm queue — confirm it's the final answer, then carry the Wave-7 copilot-action
errata + optional pattern doc as scoped follow-ups (no design decision needed).

---

## 4. Next step

The user picks **one** (or a small batch) of the open questions to brainstorm in depth. Each chosen
question runs the brainstorming gate (resolve the "user decisions needed" list above), then a writing-plan,
then implementation.

Suggested first pick: **P5.1 — Context Budget Policy.** It has the smallest decision surface (mostly
confirming suggested numbers), no dependencies, unblocks every downstream agent spec, and is fully
backend-only. A natural second batch is **P5.2 + P5.4** (brief refresh + rubric enforcement) since they
are independent of each other and each unblocks a Layer-8 consumer.

Anything not picked stays in this brief as the standing EXPLORE-phase record; re-enter at §3's recommended
order when capacity opens.
