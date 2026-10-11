# YUK-1404 — block_merge stored-fact admission + confirm_lossy (repair)

## Scope

Repair of the R1 policy defects in the merge-admission proof, on top of
`e1c5a216e` (stored-fact admission + `confirm_lossy` acceptance contract).
Owned files only:

- `src/kernel/proposals/block-merge-admission.ts` — evaluator + fact loader.
- `src/kernel/proposals/block-merge-admission.unit.test.ts` — focused
  evaluator invariants.
- This report.

`mergeQuestions` primitive, inbox seams, `confirm_lossy` schema, transaction
locks, CAS/receipt paths: untouched. DB tests: **UNRUN** locally (per task
constraint); behavior claims below rest on unit tests + code inspection only.

## Defects fixed

1. **Sorted validation order.** The evaluator sorted ranges by
   `(min page, ordinal)` and proved adjacency on the sorted chain, but
   `mergeQuestions` absorbs members in the caller's `mergeIds` order. A
   reversed payload could pass sorted validation and then be mutated in
   garbled order irreversibly. Now the proven chain is
   `[primary, ...effectiveMergeIds]` in original payload order (dedup +
   primary-strip only — identical to the primitive's effective `mergeIds`).
2. **gap-0 adjacency.** `gap ∈ [0, 1]` admitted same-page pairs (and
   `gap < 0` only rejected partial overlap). Now each next block must start
   at exactly `prev.max + 1`: same-page, overlap, backward order, and real
   gaps all fail as `pages_not_adjacent`. AI same-page proposals stay
   internal (inbox filter unchanged); the learner-initiated direct merge
   tool never consults this evaluator.
3. **Ambiguous intra-block page_spans.** Previously only `min/max` were
   derived, silently tolerating duplicated, out-of-order, non-integer, or
   internally gapped stored spans. Now `contiguousPages` requires the
   stored sequence to be a strict `+1` integer progression; anything else
   fails closed as `ambiguous_page_index`. All-placeholder chains (every
   block min 0 — the docx/Tencent fallback signature) remain rejected.
4. **Unknown own number treated as "no conflict".** `endsMidQuestion` and
   `continuesOptionSequence` could rescue a block whose own question number
   the parser cannot read (`'5-6'`, `百`, `两百`, …). Unparseable is not
   "no number": it proves neither conflict nor continuity, so it now fails
   closed as `missing_continuity`. Both rescue helpers are removed —
   they only ever executed for `kind === 'unknown'` leads (null and
   sub-continuations short-circuited earlier), i.e. they existed solely as
   the unknown-number escape hatch. Parsing itself is unchanged; no broader
   numeral parser was added.
5. **`ordinal` removed from the proof surface.** After strict `+1` chain
   ordering the evaluator no longer reads `question_block.ordinal`; the
   field is dropped from `BlockMergeAdmissionFacts` and the loader select
   so the interface honestly lists only what the proof consumes.

## Unchanged invariants (verified by the unit suite)

- `effectiveMergeIds`: dedup of input ids with the primary stripped,
  original order preserved — asserted equal to the payload order even on
  rejected reversed chains.
- Session / canonical `source_document` / resolvable-document checks.
- Sub-continuation `(2)` after `(1)` same-style `+1` admits; a next block
  carrying a top-level number, a fresh sub-sequence, or a conflicting
  number fails `conflicting_question_number`.
- Null `structured` anywhere → `missing_continuity`.
- Inbox seams (list / counts / detail) filter only `pending` block_merges —
  terminal/history visibility and accepted replay paths untouched.
- Preflight + in-transaction locked re-check (`assertBlockMergeAdmission`)
  semantics unchanged; the 409 `merge_inadmissible` shape unchanged.

## Verification (this head)

- `pnpm vitest run --config vitest.unit.config.ts
  src/kernel/proposals/block-merge-admission.unit.test.ts` — **28/28 PASS**
  (was 24 on `e1c5a216e`; +3 new invariants, -1 rewritten same-page case,
  net +4).
- `pnpm typecheck` — PASS.
- `pnpm lint` (`biome check .`) — 0 errors (174 pre-existing repo warnings,
  none in changed files).
- `pnpm build` — PASS (rw:web + server + worker + migrate bundles).
- All run via `sh /tmp/yuk1359-offline-env.sh`.
- DB tests (`proposal-appliers.db.test.ts` et al.): **UNRUN** — deferred to
  CI Gate per local test policy.

## Historical evidence

- Original author claim of 24/24 unit PASS and R1 typecheck on
  `e1c5a216e` — retained as historical evidence of that head only; not a
  claim about this repaired head.

## Status for review

A fresh R2 delegation against the repaired commit is expected; this head is
the input to that review, not a third review round.
