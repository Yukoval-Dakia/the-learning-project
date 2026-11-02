# Lane plan — T-QP (YUK-165): `question_part` ActivityKind

**Branch**: `yuk-165-question-part` (worktree `/private/tmp/tlp-tqp`, off `origin/main`)
**ADR**: ADR-0014 §1 (ActivityKind) + §5 (SchedulingPolicy / capability registry). Already
adopted — this lane implements the stub, no new ADR.

---

## The part data-model decision (and why)

**Decision: a part IS a `question` row.** A multi-part question is represented as a
parent `question` row plus N child `question` rows, where each child is:

- tagged `kind = 'question_part'` (the existing `question.kind` text column — the
  semantic activity tag), and
- linked to its parent via a new nullable `question.parent_question_id` column
  (mirrors the established `root_question_id` / `parent_variant_id` parent-ref
  precedent — same pattern, new axis: composition rather than variant lineage), and
- ordered within the parent via a new nullable `question.part_index` integer column.

**Why this shape (vs. a separate `question_part` table):**

1. **FSRS for free, algorithm reuse mandated by the spec.** The live review path
   (`app/api/review/due`, `app/api/review/submit`, `src/server/fsrs/state.ts`) keys
   entirely on `material_fsrs_state.subject_kind = 'question'` + `event(action in
   {attempt,review}, subject_kind='question')`. Because a part is a question row, its
   FSRS state and attempt/review events are written with `subject_kind = 'question'`
   and its own question id — so it flows through the EXISTING `fsrs_question`
   scheduling + due-queue path with **zero changes** to those routes. Independent
   scheduling falls out of parts being independent question rows. No new scheduling
   algorithm is invented (spec §"Critical safety" + §"No overengineering").

2. **Parts surface in review automatically.** The due query selects from the
   `question` table joined on `material_fsrs_state` (`subject_kind='question'`); part
   rows are in `question`, so a part that has FSRS state or a failure attempt appears
   in the due queue with no query change. Verified by regression test
   (`tests/db/review/question-part-due.test.ts`): the plain-question due list is
   byte-identical with vs. without parts present, and a reviewed part surfaces.

3. **`activity_ref` semantics, storage stays `question`.** ADR-0014 §1 wants new
   interfaces to carry `ActivityRef { kind, id }`. The part's activity-level identity
   is `{ kind: 'question_part', id: <partQuestionId> }` (new `questionPartRef()`
   helper in `src/core/schema/activity.ts`). The storage / FSRS / review layer keys on
   the part's **question id** with `subject_kind='question'`. The review-submit guard
   (`normalizeReviewSubmitActivityRef`, which rejects `kind !== 'question'`) is left
   UNCHANGED — a part is reviewed via its own question id, so callers may submit
   `{ kind: 'question', id: partId }`. The `question_part` kind is the composition tag,
   not a separate storage/review subject_kind. This avoids touching the review path's
   single-owner FSRS guarantees.

**Scheduler registry (ADR-0014 §5).** The capability registry was judge-only. This
lane adds the scheduler half so the framework knows `question_part` maps to the `fsrs`
policy:

- `SchedulerCapabilityRunner` + `SchedulingInput` / `SchedulingDecision` types
  (`src/core/capability/schedulers/types.ts`).
- An `fsrs` scheduler capability (`src/core/capability/schedulers/fsrs.ts`) declaring
  `supports_activity_kinds: ['question', 'question_part']` and delegating to the
  existing `scheduleReview()` in `src/server/review/fsrs.ts` — it does NOT reimplement
  FSRS, it wraps the one true scheduler so registry-driven callers and the live review
  path share identical math.
- `CapabilityManifest` gains an optional `supports_activity_kinds` field so a scheduler
  can declare which activity kinds it serves.
- `CapabilityRegistry` gains `registerScheduler` / `resolveScheduler` / `hasScheduler`
  / `listSchedulers`, registered in `createDefaultRegistry()`.
- `validateProfile` gains `validateSchedulingPolicy`: `schedulingHints.default_policy`
  must resolve to a registered scheduler that supports `'question'`. All three current
  profiles declare `default_policy: 'fsrs'`, so the `fsrs` scheduler must be registered
  or `audit:profile` fails — it is.

**Part-creation owner.** `src/server/questions/parts.ts` provides `createQuestionPart(tx,
input)` — the single owner that inserts a part question row under a parent (mirrors how
ingestion creates questions inline; `created_by` stays NULL by design, provenance via
`metadata` + events, per the scout). It is the INSERT write path for the two new columns
(`parent_question_id`, `part_index`), satisfying `audit:schema` without an allowlist
entry. `representMultiPartQuestion(tx, input)` composes a parent + ordered parts in one
call so a multi-part source is REPRESENTABLE (auto-splitting itself rides T-OC — deferred).

---

## Files

### Create
- `src/core/capability/schedulers/types.ts` — `SchedulerCapabilityRunner`,
  `SchedulingInput`, `SchedulingDecision`.
- `src/core/capability/schedulers/fsrs.ts` — `fsrsSchedulerCapability` (wraps
  `scheduleReview`, declares question + question_part support).
- `src/core/capability/schedulers/fsrs.test.ts` — unit: maps coarse_outcome→rating,
  delegates to scheduleReview, declares both activity kinds.
- `src/server/questions/parts.ts` — `createQuestionPart` + `representMultiPartQuestion`
  owner service (INSERT write path for new columns).
- `tests/db/questions/parts.test.ts` — DB: part is a question row, parent link +
  part_index persisted, `created_by` NULL.
- `tests/db/review/question-part-due.test.ts` — DB regression: plain-question due list
  identical with vs. without parts; a reviewed/failed part surfaces in the due queue.

### Modify
- `src/db/schema.ts` — add `parent_question_id` (text, nullable) + `part_index`
  (integer, nullable) to `question`.
- `drizzle/0022_question_part.sql` (+ `drizzle/meta/*`) — generated migration.
- `src/core/schema/activity.ts` — add `questionPartRef()` helper.
- `src/core/schema/capability.ts` — add optional `supports_activity_kinds` to
  `CapabilityManifest`.
- `src/core/capability/registry.ts` — scheduler register/resolve/has/list methods.
- `src/core/capability/judges/index.ts` — register `fsrsSchedulerCapability` in the
  default registry.
- `src/core/capability/validate-profile.ts` — `validateSchedulingPolicy`.
- `src/core/capability/registry.test.ts` (create if absent) / scheduler coverage.
- `docs/adr/0014-...md` — one-line status note: question_part stub → implemented (slice
  1), parent aggregation deferred.

## Build order
1. schema columns + migration (`db:generate`).
2. activity `questionPartRef` + capability manifest `supports_activity_kinds`.
3. scheduler types + fsrs scheduler + registry methods + default registry registration.
4. `validateSchedulingPolicy` in validate-profile.
5. part-creation owner (`src/server/questions/parts.ts`).
6. tests (unit + DB regression).
7. ADR status note.
8. gate.

---

## DEFERRED (do NOT build this lane)
- **Parent-level aggregation scheduling** (ADR-0014 line 250): only when fragmented
  review experience is OBSERVED. Parts schedule independently for now.
- **Part presentation in the review UI**: needs design-doc pre-flight (CLAUDE.md UI
  rule). The due queue returns part question rows like any question; no UI work here.
- **Auto-splitting multi-part sources into parts**: rides future T-OC integration.
  This lane only makes a multi-part question REPRESENTABLE via the owner; it does not
  parse a source into parts.
- **Relaxing the review-submit `kind` guard to accept `kind:'question_part'`**: not
  needed — parts review via their own question id with `kind:'question'`. Revisit only
  if a caller must address a part by its `question_part` activity ref through submit.
