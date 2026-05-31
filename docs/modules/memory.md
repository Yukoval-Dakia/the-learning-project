# Memory brief layer (`memory_brief_note`)

> Last reviewed: 2026-05-31 (P5.2 / YUK-143)
>
> Substrate decisions: [ADR-0015](../adr/0015-learning-record-memory-brief.md) (brief as
> first-class entity) and [ADR-0017](../adr/0017-memory-mem0-plus-brief-layer.md) (Mem0 + brief
> layer: scope taxonomy, write triggers, anti-storm, cost). Code:
> `src/server/memory/{brief,triggers,active-subjects,scope_tagger,client}.ts`.

## What it is

`memory_brief_note` is the pre-summarized "方向感" the Layer-8 orchestrator, Dreaming, and Coach read
before consulting the SoT. Each row is a three-段 short text (recent week / recent months / long
term) keyed by `scope_key`. Two scopes are governed today (P5.2 non-goals: no `topic:` /
`mistake_cluster:` / `meta:` briefs — the `MemoryBriefScopeKey` validator only permits
`global` + `subject:*`):

| scope_key | refresh model |
|---|---|
| `global` | freshness-gated: 24h-stale sweep + `scopeHasNewEvidence` gate (unchanged) |
| `subject:<id>` | **activity-gated** (P5.2): refreshed when the subject has recent learning activity |

## Refresh pipeline

The nightly sweep (`buildMemoryBriefSweepHandler`, scheduled `0 3 * * *` Asia/Shanghai) enqueues
per-scope regen jobs onto `MEMORY_BRIEF_REGEN_QUEUE`; `buildMemoryBriefRegenHandler` drains them and
calls `regenerateMemoryBrief`, which upserts the `memory_brief_note` row (`onConflictDoUpdate` on the
unique `scope_key`). `enqueueBriefRegen` dedups per scope on a 6-minute singleton window.

### `global` path (BR-6, unchanged)

`listStaleBriefScopes` selects every existing brief row whose `refreshed_at IS NULL OR < now() -
24h` and enqueues it. The regen handler gates each on `scopeHasNewEvidence(scopeKey)` and loads its
events via `loadEventsFromDb` (`affected_scopes @> [scopeKey]`). `global` is always enqueued and is
**not** subject to the per-subject run budget.

### `subject:*` activity-gated layer (P5.2 / BR-1, BR-10)

A per-subject brief refreshes when the subject has **≥ 1 qualifying activity event newer than that
brief's `refreshed_at`** (or, for a never-built subject, any qualifying activity within a bounded
30-day lookback window — BR-5). Dormant subjects incur no refresh cost.

`listActiveSubjectsSinceRefresh` (`active-subjects.ts`, §3.2) discovers the active set:

1. Load per-subject brief watermarks (`scope_key LIKE 'subject:%'` → `refreshed_at`).
2. Scan qualifying activity events (`attempt`, `review`, `experimental:record_capture`) newer than
   a single global scan floor.
3. Resolve each event → subject via the **canonical knowledge→subject bridge** —
   `knowledge_ids[0] → getEffectiveDomain → resolveSubjectProfile.id` (BR-4,
   `@/server/knowledge/subject-resolution.batchResolveSubjectIds`, the SAME bridge the review
   scheduler uses, so "active subject" and "review round-robin subject" can never diverge). Orphan
   ids and capture events (no `referenced_knowledge_ids`) fall back to the default subject (YUK-56).
4. Group by subject, keep the max `created_at`; a subject is active iff its newest qualifying event
   is strictly after its brief's `refreshed_at` (or it has no brief row + in-window activity).

**Why not `affected_scopes` (BR-10, load-bearing):** the two core learning events (`attempt` /
`review`) carry only `payload.referenced_knowledge_ids`, never `subject_id` / `domain`, so
`computeAffectedScopes` tags them `global` + `topic:<id>` but **never** `subject:X`. Reading
`affected_scopes @> [subject:X]` would return ~0 rows → an empty brief regenerated every night, and
`scopeHasNewEvidence('subject:X')` would return false forever → never refreshing despite activity.
The subject regen path therefore injects a knowledge-resolved event window
(`loadSubjectBriefEvents`) through `regenerateMemoryBrief`'s existing `loadEvents` param and skips
the `affected_scopes` freshness guard (freshness is already decided by the sweep).

Per-subject briefs are parallel-safe by construction: distinct `scope_key` rows guarded by
`memory_brief_note_scope_key_unique` + distinct `memory.regen.<scope_key>` singleton locks, so
`subject:A` and `subject:B` never clobber each other (BR-7).

## Budgets (single source: `src/server/ai/tools/budgets.ts`)

`BRIEF_REFRESH_BUDGET` is the only place the P5.2 limits live (BR-9):

- `maxSubjectsPerRun` (12) — max subjects refreshed in one nightly sweep. When more are active, the
  sweep enqueues the top N by activity recency (max `created_at` DESC) and defers the rest to the
  next run (they stay eligible — no starvation). `global` is exempt.
- `maxEventsPerBrief` (50) — max recent events fed into a single brief's summarization. Formalizes
  the former hardcoded `.limit(50)` in `brief.ts loadEventsFromDb`; applied to both the
  `affected_scopes` loader and the per-subject knowledge-resolved loader. A subject with >50 recent
  events is summarized from the 50 most recent (graceful truncation, not rejection).

## Out of scope (P5.2 non-goals)

Goal-coupling (refresh is activity-gated, never goal-gated), real-time refresh (stays nightly
batch), per-subject brief UI, new brief scopes, long-term staleness expiry (P5.3), and tagging
`subject:` at event-write time (would force a DB read into the synchronous `writeEvent` hot path).
