# T-CS (YUK-168) — Cross-subject scheduling v1 (round-robin) — lane plan

Status: implemented (2026-05-30)
Basis: ADR-0014 §5 (line 242, "Cross-subject scheduling v1", Phase N+3). Composes with YUK-167 / ADR-0025 review soft-bias. No new ADR.

## Problem

`handleReviewDue` (`src/server/review/due-list.ts`) selected the returned review page by a PLAIN global-due `combined.slice(0, limit)`. When one learning-subject has many overdue items it dominates the whole page and starves the others. We want the page balanced across the subjects that have due items, WITHOUT widening the due pool or touching FSRS / writes.

## Files touched

- `src/server/review/due-list.ts` — selection change (round-robin) + batch subject resolution. The only production file changed.
- `app/api/review/due/cross-subject.test.ts` — new DB test (multi-subject balance, only-due, single-subject degeneration, orphan-id degeneration, soft-bias composition).
- `docs/adr/0014-generalized-activity-and-capability-registry.md` — 1-line status note (v1 implemented).
- (no schema change, no migration, no new ADR)

## Algorithm — round-robin cross-subject SELECTION

1. Build the SAME due pool as today: `combined = [...newRows (never-reviewed, fsrs_state === null), ...dueRows (overdue, fsrs_state !== null)]`. Pool semantics unchanged — we do NOT widen what counts as "due".
2. Batch-resolve each candidate's learning-subject id from its FIRST knowledge id (`getEffectiveDomain` → `resolveSubjectProfile(domain).id`), deduplicating the parent-chain walk across the pool (`batchResolveSubjectIds`) so it is O(unique-first-knowledge-ids) DB reads, not O(N). Orphan / missing ids fall back to the default profile id (YUK-56).
3. Round-robin SELECT, applied per-segment to preserve the legacy never-reviewed-first contract:
   - `roundRobinBySubject(newSegment, limit)` then `roundRobinBySubject(overdueSegment, limit - selectedNew.length)`; `page = [...selectedNew, ...selectedOverdue]`.
   - Within a segment: partition rows into per-subject buckets (subject order = first-seen order in the most-due-ordered rows; within-subject order = the rows' existing most-due order). Cycle the buckets taking the next item from each in turn until the limit is reached or the pool is exhausted.
4. Compose with soft-bias (unchanged): `rerankOverdueByGoals(page, listGoals)` re-orders ONLY the overdue tail of the round-robin-selected page so goal-relevant items lead, stably. Round-robin decides WHICH items (subject-balanced); soft-bias decides the ORDER within them (goal-first). Soft-bias remains set-preserving.

## Single-subject degeneration (proof)

`roundRobinBySubject` with a single subject produces exactly one bucket and returns `rows.slice(0, limit)`. Per segment:
- `selectedNew = newSegment.slice(0, limit)`; `selectedOverdue = overdueSegment.slice(0, limit - selectedNew.length)`.
- `page = [...newSegment.slice(0, limit), ...overdueSegment.slice(0, limit - min(limit, newSegment.length))]` which equals `combined.slice(0, limit)` for every `limit` (the never-reviewed block wins the budget first, identical to the old slice).

Therefore: when only one subject has due items the output is BYTE-IDENTICAL to the pre-change global-due behavior. Orphan / missing knowledge ids all resolve to the SAME default profile, so any fixture that does not seed real `knowledge` rows is single-subject and stays green unchanged — which is why every existing route/soft-bias/part test passes without edits.

## NON-NEGOTIABLE invariants held

- Only DUE items returned (same pool: overdue `material_fsrs_state` rows + never-reviewed failure slice). Never widened, never a non-due item.
- ZERO writes. Read-only selection/ordering change. FSRS, `material_fsrs_state`, due_at, submit route, FSRS algorithm all untouched.
- Default-ON, no flag (safe because it degenerates to today for single-subject).
- ND-5 composition with soft-bias preserved: round-robin selects the set; soft-bias only re-orders within it.

## Existing tests

No existing review/due test was edited. All current fixtures (`route.test.ts`, `soft-bias.test.ts`, `part-regression.test.ts`) use `knowledge_ids: ['k1']` / `['k2']` / `['k3']` with NO seeded `knowledge` rows, so every question resolves to the default profile → single subject → degenerate → byte-identical → green. The scout's "assertions requiring updates" list assumed a different (non-degenerate) round-robin baseline; under the per-segment single-subject degeneration those assertions are correct as-is and are intentionally left unchanged.
