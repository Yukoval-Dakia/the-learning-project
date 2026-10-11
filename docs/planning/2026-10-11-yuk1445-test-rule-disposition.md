# YUK-1445 owner test-rule disposition (2026-10-11 22:15 rule)

Scope: audit of the test lines added on `feat/yuk-1445-choice-entry-publication`
versus `origin/main` in exactly two files —
`src/core/schema/assessment/evaluation.test.ts` (+328 appended) and
`src/server/questions/publisher.db.test.ts` (+399 appended, import block only
otherwise). Owner rule binding: tests must enter at route/job/DB transaction,
settlement/grading chain, agent tool contract, or a public deterministic-core
entry; one case per invariant with extras only for distinct failure modes;
internal-helper tests, parameter permutations, mock interaction/call-count
assertions and per-branch cases are banned; mocks may stub external
provider/network/clock only.

## Disposition

`publisher.db.test.ts` — all 3 new cases retained unchanged. Each enters a real
DB transaction and carries one invariant:

- `choice entry cannot publish an admitted revision without calibration` —
  `publishQuestionGroup` transaction (kernel `assessment-publication.ts:544-565`);
  atomic recalibration rejection with zero committed rows.
- `choice entry retains its proof through canonical source verification and
  rejects stale proof after edits` — `publishQuestionGroup` /
  `publishQuestionGroupFromRow` / `runSolveCheck`→`readVerifiedChoiceEntry`
  (production caller `source_verify.ts:457`, a job entry); source authority,
  proof retention without relabel, stale-proof rejection after raw/typed edits.
  The `runTaskFn` stub mocks the external provider port only, as allowed.
- `rolls back typed choice edits and permits unchanged content plus metadata
  edits` — `editQuestion` transaction (`server/questions/write.ts`); whole-patch
  rollback of unsupported typed-choice edits.

`evaluation.test.ts` — appended `choice entry frozen method` block audited at 7
cases; 5 removed, 2 retained:

- RETAINED `grades the declared opaque ID and every distractor through the real
  evaluator` — genuine deterministic result. Entry: `calibrateChoiceMethod`
  (production caller `choice-entry.ts:215`, invoked from the
  `store_sourced_question` agent tool at `store-sourced-question.ts:261`), which
  drives `projectPracticeIssuance` + `evaluateSubmissionCore` — the public
  deterministic grading core — for every probe.
- RETAINED `strips private references and rejects key-bearing presentation` —
  key privacy. Entry: `projectPracticeIssuance` public DTO
  (`PracticeIssuanceDto` strictObject, `dto.ts:57-64`) plus the strict
  `QuestionPresentation` schema that is projected into that DTO, so an
  `answer_key` property is a real leak path. The trailing
  `validateQuestionPresentation` `presentation_unit_slot_mismatch` assertion was
  trimmed: it is a per-branch validation case with no key-privacy role.
- REMOVED `rejects reused calibration after the typed key changes`,
  `refuses one solve reused twice`, `requires a separate consistent source check
  before admitting a calibrated key`, `binds admission to the raw row and
  attributable source` — in-vitro permutation/branch batteries on
  `validateChoiceCalibration` / `validateChoiceEntryRowBinding` /
  `calibrateChoiceMethod`'s internal guards. Their invariants are enforced and
  covered at the real boundaries retained above: the publisher transaction
  re-validates via `assessment-publication.ts:555` and `:1041`, the capability
  rejects conflict/unknown sources with typed 422 errors before any evidence
  exists (`choice-entry.ts:162-169`), and the DB cases exercise stale-proof and
  changed-key rejection end-to-end.
- REMOVED `rejects a raw prompt or choice edit against the unchanged structured
  entry` — parameter permutations plus per-branch assertions (metadata-equal,
  `structured: null` legacy fallback) on the `normalizeQuestionRowToContract`
  helper; covered at the real seam by the DB edit loops.

Counts: evaluation.test.ts new cases 7 → 2 (5 removed, 1 retained case trimmed
by one assertion); publisher.db.test.ts new cases 3 → 3 (unchanged). Appended
line count 328 → 127. No preexisting case in either file was modified.

## Verification

Commands run in this worktree at the pruned tree, serialized:

- `pnpm vitest run --config vitest.unit.config.ts
  src/core/schema/assessment/evaluation.test.ts` — retained cases pass.
- `pnpm audit:test-policy` (base = merge-base HEAD origin/main) — zero errors.
- `pnpm typecheck` / `pnpm lint` — pass.

DB tests were NOT run in this lane: `publisher.db.test.ts` is byte-identical to
the parent's sealed 0fa state (3 PASS), so the sealed execution remains the
authoritative evidence. No production file, helper, schema, fixture value,
gate exemption, task/provider/registry entry, or preexisting assertion was
touched; no fixture, key, source or score was manufactured.
