# ADR-0017: Memory layer = Mem0 (facts) + brief layer (per-scope markdown)

**Status:** Accepted
**Date:** 2026-05-23 (accepted 2026-05-23 via PR #102)
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0001（TS monolith + Python sidecar escape hatch）/ ADR-0006 v2（events 不可变 action log）/ ADR-0007（single-user）/ ADR-0012（mastery as derived view）/ ADR-0015（learning_record + memory_brief_note 一等领域实体）

## Context

ADR-0015 §2 forward-locked the write path for `memory_brief_note` to a "Dreaming-owned" module, with the actual implementation deferred to Phase 2C. Two things have happened since:

1. [YUK-34](https://linear.app/yukoval-studios/issue/YUK-34) Phase A (PR #99 / `docs/design/2026-05-23-mempalace-evaluation.md`) concluded **NO-GO on mempalace** as the memory sidecar. mempalace stores verbatim text and refuses to summarize — wrong tool for ADR-0015 §2's 3-window summary need. The doc recommended a "TS-native alternative" but did not specify shape.

2. A design conversation (2026-05-23, transcript not in repo) clarified the actual requirement: memory is a **dual-layer system serving a central LLM orchestrator** — not a single retrieval index. The orchestrator needs both a **pre-summarized impression** ("方向感") and **on-demand fact retrieval** ("细节"). Forgetting requirement is at-minimum **supersede** (new facts override old). Memory is explicitly **not SoT** — the SoT remains `event` (ADR-0006 v2) + `knowledge_mastery` view (ADR-0012). Memory is an **attention prior** that the orchestrator reads before consulting SoT.

This ADR codifies the dual-layer engineered solution that emerged.

## Decision

Implement memory as **two coupled layers** with clear write-path ownership:

### Layer 1 — Fact layer (Mem0 with pgvector backend)

- Use [Mem0](https://github.com/mem0ai/mem0) (TS SDK, `mem0ai` npm) for AI-derived atomic facts about the user.
- Backend: **pgvector** in the existing docker-compose Postgres. **No new container**, no new state plane.
- LLM provider: project's existing Anthropic (mimo-v2.5) runner, configured via Mem0's custom-provider hook.
- Single-owner write path: `src/server/memory/client.ts` is the only module that calls Mem0 `add` / `update` / `delete`.
- Supersede semantics handed to Mem0's internal LLM-driven dedup — we do not roll our own fact-level supersede algorithm.

### Layer 2 — Brief layer (per-scope 3-window markdown)

- `memory_brief_note` table (already defined in `src/db/schema.ts:257-282`) holds one row per `scope_key`.
- Each row = three semi-structured markdown windows (`recent_week_md` / `recent_months_md` / `long_term_md`) + evidence_ids pointing back to SoT rows only.
- Single-owner write path: `src/server/memory/brief.ts` — satisfies ADR-0015 §2's "Dreaming-owned" forward lock.
- Brief regen reads **Mem0 curated facts + raw recent_week events** (per-design "Brief layer input mode (b)" 2026-05-23) → LLM summarizes per prefix-specific template → integer upsert. Dedup/supersede is implicit via wholesale row overwrite (ADR-0015 §2 already mandates "upsert 不留历史").

**Evidence contract — keep SoT and Mem0 namespaces separate**. ADR-0015 §2 defines `recent_*_evidence_ids: string[]` as references to `event` / `learning_record` rows (audit-replay-safe SoT ids). This ADR preserves that contract — `memory_brief_note.recent_*_evidence_ids` continues to hold **SoT ids only**. Mem0 fact-ids that informed a regen are **not** stored in the brief row; they live in Mem0's own metadata (Mem0 tracks its own provenance internally). If a future audit needs the "which Mem0 facts contributed to this brief at refresh time T" trail, that has to come from re-querying Mem0 with the same scope + a time filter — not from `evidence_ids`. Rationale: SoT ids are auditable / immutable; Mem0 facts are derived state that can supersede over time, so storing their ids in brief rows would create a dangling-reference class of bug. **If this turns out to be insufficient at impl time**, the right escape is to add a separate column (e.g. `recent_week_mem0_fact_refs jsonb`) — **do not** widen `evidence_ids` to mix namespaces.

### Scope taxonomy — 5 fixed prefix, LLM-dynamic suffix

| Prefix | Example scope_key | Purpose |
|---|---|---|
| `global` | `global` (singular) | Orchestrator entry impression |
| `subject:*` | `subject:wenyan` | Subject-level impression |
| `topic:*` | `topic:语气词` | Knowledge-node-grained impression |
| `mistake_cluster:*` | `mistake_cluster:particle_punctuation_confusion` | LLM-named recurring cognitive patterns |
| `meta:orchestrator_self` | (singular) | AI's procedural memory about how to talk to this user; chat-derived writes land here |

Prefix set is **fixed at the framework level** — LLM cannot invent new prefixes. Suffix is LLM-dynamic — LLM may propose new scope_keys within an existing prefix during brief regen (`proposed_new_scopes: []` in regen output, materialized on next pass).

**Not a brief scope** — `meta:system_state` is **excluded**. Operational state (pending proposals, FSRS due count, vision rescue backlog) is a live SQL dashboard query, not a memory impression. Orchestrator reads it separately via plain SQL when needed.

### Write triggers (three paths)

1. **Event-ingest** — every event write path tags the event with `affected_scopes: string[]` (new column on `event` table, GIN-indexed). A pg-boss subscriber on event creation calls `mem0.add(event)` and enqueues brief regen for affected scopes.
2. **Chat-derived** — Copilot conversation turns can produce user-preference facts ("user prefers analogies", "user wants reasoning chain shown"). Per turn, the orchestrator decides whether to call `mem0.add(chat_message, scope='meta:orchestrator_self')`. Mem0's internal extraction filters non-signal turns.
3. **Cron daily sweep** — nightly job iterates **stale** `memory_brief_note` rows — concretely `WHERE refreshed_at IS NULL OR refreshed_at < now() - interval '24 hours'` — and enqueues brief regen for each. Catches anything missed by event triggers + ensures even dormant scopes get re-evaluated (an old, untouched brief is the signal "this scope has been quiet" — orchestrator reads the staleness via `refreshed_at` / `latest_evidence_at` metadata, separate from the freshness-check that gates regen).

### Anti-storm

- pg-boss `singletonKey: 'memory.regen.<scope_key>'` with 6-minute window — collapse burst event activity into a single regen per scope per window.
- Brief regen handler checks `latest_event_at(scope) > brief.latest_evidence_at + epsilon` before calling LLM — skip no-op regen.

### Schema additions

| Change | Risk | Migration cost |
|---|---|---|
| `pgvector` extension on docker-compose Postgres | Low (single-user, idempotent `CREATE EXTENSION IF NOT EXISTS`) | One-line addition |
| `event.affected_scopes text[]` (nullable, GIN index) | Low; existing rows backfilled to `[]` | Drizzle generate + push |
| `memory_brief_note.latest_evidence_at TIMESTAMP` + `.evidence_count INT` | Low; nullable, existing rows default null | Drizzle generate + push |
| Mem0's internal tables (created by Mem0 init in pgvector mode) | Sandbox: Mem0 owns its own schema namespace | Mem0 manages |

## Read pattern (informational — not enforced)

Orchestrator turn flow:

```
1. read memory_brief_note(scope='global')                    — gestalt
2. follow ## Active scopes pointer to subject/topic briefs   — focused context
3. for specific lookups: mem0.search(query, filters)         — on-demand facts
4. for precise numbers: SQL query SoT (event / mastery view) — truth
```

Token economy:
- Brief load = ~1k tokens (always in context for orientation)
- Mem0 search = ~300 tokens / query (on-demand, agent-tool-callable)
- SoT query = structured, near-zero LLM token cost

## Consequences

### ✅ Acquired

- ADR-0015 §2's forward-locked write path concretized — `src/server/memory/brief.ts` is the Dreaming-owned module.
- `memory_brief_note` table revived (was unused since schema landed in plan 2026-05-18).
- mempalace evaluation NO-GO (PR #99) made actionable — alternative is specified, not "TBD TS-native".
- LLM dedup/supersede cost outsourced to Mem0 — no roll-your-own algorithm.

### ⚠️ Accepted costs

- New runtime dep: `mem0ai` npm package (TS SDK). Pinned + version-locked per ADR-0001 escape-hatch criteria (we have an exit ladder: if Mem0 breaks, drop client wrapper + summarize directly over events). The dep does NOT introduce Python — Mem0 TS SDK is first-class.
- New schema migration: pgvector extension. Reversible — `DROP EXTENSION` + drop Mem0 tables, brief layer can still function from raw events alone (lossy but recoverable).
- LLM cost: estimated $0.20-$0.60/day at active learning rate (10 active scopes × 1-3 regen/day × $0.02-$0.05 per LLM call). Bounded by anti-storm.
- Acid-test-2 concept (foundation-closeout) applies: this change touches `event` table schema (+1 column) — counts as framework delta, must be documented in any concurrent foundation-closeout work.

### 🔴 Risks

- **Mem0 OSS maturity**: Mem0 is at 0.x (GA but still evolving). Breaking changes possible. Mitigation: thin client wrapper in `src/server/memory/client.ts` isolates the dep surface; if breaking change, only that file changes.
- **Chinese embedding quality** (default Mem0 embeddings may be English-biased): mitigated by configuring embedding to Voyage / Anthropic via Mem0's provider hook. Verified in Phase B Mem0 spike before committing.
- **Anti-storm dedup correctness under burst**: at high event rate, 6-min singleton window may collapse legitimately distinct events. Acceptable for personal scale; revisit if multi-event-per-second writes materialize (we are nowhere near).
- **Brief LLM cost overrun**: if scope count grows to ~100, daily cron sweep = 100 LLM calls = ~$2-5/day. Mitigation in Phase C: scope archival (mark archived_at, exclude from cron sweep), tiered models (Haiku for short windows, Sonnet for long_term).

## Touching ADR-0015 §2

This ADR **does not supersede** ADR-0015. §1 (`learning_record`) is untouched. §2's forward lock on "Dreaming-owned module, expected path `src/server/dreaming/brief.ts`, Phase 2C" is **revised** by this ADR:

- New owner location: `src/server/memory/brief.ts` (under `memory/` not `dreaming/` — reflects the dual-layer architecture; the Dreaming agent concept remains but is now a thinner cron orchestration layer that calls into `memory/`).
- "Phase 2C" timing now becomes "Phase B per YUK-37" — concrete commit.
- §2's other constraints (唯一 `scope_key` index / upsert 不留历史 / 周期重算) preserved verbatim.

## Triggers for re-evaluation

- Mem0 abandoned / unmaintained → swap to Zep / Letta / roll-our-own; client.ts wrapper makes this a single-file change
- LLM cost grows beyond comfort → tier models per template / archive cold scopes / shrink window granularity
- Token economy of "always-loaded brief" hits orchestrator context limit → switch to retrieval-only mode (skip brief layer, query Mem0 facts on demand)
- pgvector performance ceiling under our scale (~1k events) → migrate to Qdrant / managed Mem0 hosted

## One-line summary

> **Memory = Mem0 facts (engineered) + thin brief layer (in-house) — neither is SoT; both are attention prior for the orchestrator LLM.**
