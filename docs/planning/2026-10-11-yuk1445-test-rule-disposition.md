# YUK-1445 test-rule disposition

This continuation starts from clean
`0c1c49bf62934f21b923e858faf5bed6afc48306` in
`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1445-choice-entry-publication`.
The owner supplied four remaining test findings. Only
`src/core/schema/assessment/evaluation.test.ts`,
`src/server/questions/publisher.db.test.ts` and this document are owned here.
Production remains byte-identical to
`0fa805fd9e43cec7629b092f2563f22c685da1a5`.

The owner's 2026-10-11 22:15 rule permits tests at route/job/DB transaction,
real settlement or grading chain, agent tool contract, or public deterministic
core entry. Keep one case per invariant. Internal-helper-only tests, parameter
permutations, mock interaction or call-count assertions and per-branch tests
are banned. Mocks may replace only external provider, network or clock ports.

## Retained cases and entry points

- E1, `evaluation.test.ts:1525`, grades one stable opaque ID from a shuffled
  frozen issuance. It calls `projectPracticeIssuance` and then
  `evaluateSubmissionCore` directly with that issuance's identity and part
  scope. One submission selects `opaque-blue`; the completed unit and total
  must award the printed 2 points despite the conflicting private reference.
  The public option order is checked to establish the shuffled input. There
  is no distractor/blank loop, calibration helper call or model receipt fixture.
  Production entries are `core/schema/assessment/dto.ts:88` and
  `core/schema/assessment/evaluation.ts:509`, under `src/`. Actual consumers
  include `kernel/records/assessment-issuance.ts:606` and
  `capabilities/practice/server/judge/evaluate-submission.ts:576`.
- E2, `evaluation.test.ts:1591`, withholds the private reference and scoring
  key from the actual public practice issuance. Both leak assertions apply to
  `projectPracticeIssuance`'s returned DTO. The standalone
  `QuestionPresentation.parse` injection assertion and its import are removed.
  This checks the public data boundary, without adding a schema branch test.
- DB1, `publisher.db.test.ts:334`, rejects an admitted publication without
  calibration and checks that no revision or lifecycle row commits. Its
  callback is unchanged. It enters the real publisher transaction at
  `src/kernel/records/assessment-publication.ts:472`.
- DB2, `publisher.db.test.ts:380`, preserves the original calibrated revision
  when canonical source verification rejects one captured-source change.
  First the canonical publication retains `system_verified` authority and its
  original proof. Then one actual SQL edit changes the captured source extract.
  `runSolveCheck` must fail, and canonical `publishQuestionGroupFromRow` with
  the source-verification admission must reject stale source proof. Original
  revisions, lifecycle and verification records must remain unchanged. The
  three other raw edits and the typed-key edit are removed. Production source
  verification calls these boundaries at
  `src/capabilities/practice/jobs/source_verify.ts:457` and `:767`; proof
  retention and row binding are checked at
  `src/kernel/records/assessment-publication.ts:1010` and `:1041`. The existing
  `runTaskFn` stubs replace only the external provider port. Existing recorded
  fixture receipts are unchanged and do not establish provider quality.
- DB3, `publisher.db.test.ts:606`, rolls back one mixed semantic and metadata
  edit. A single `editQuestion` call submits a changed prompt plus difficulty;
  rejection must preserve the complete working row, including its version,
  all revisions, lifecycle and audit events. The other three patch inputs,
  unchanged-content/noop check and successful difficulty-only check are removed.
  The API calls `editQuestion` at
  `src/capabilities/practice/api/question-detail.ts:194`; the transaction and
  typed-entry rejection are at `src/server/questions/write.ts:265` and `:341`.

E1 and E2 replace the two retained cases at `0c1c`; DB2 and DB3 are narrowed.
DB1 stays unchanged. The five cases deleted at `0c1c` remain deleted:
reused calibration after a key change, a reused solve, separate source-check
admission, raw-row/source binding, and raw prompt/choice normalization edits.
Their old helper/branch coverage is not claimed as current coverage.

## Inventory and immutable scope

The AST inventory uses pre-feature
`79825bb6da73f9894c65a5d6735e3725f098e8e1` and checks both raw callback bytes
and token streams. All 44 pre-feature evaluation callbacks and all 3
pre-feature publisher callbacks are unchanged. The files contain 46 and 6
case registrations respectively, including the retained 2 unit and 3 DB
feature cases. The inherited parameterized registrations expand the scoped
unit execution to 57 tests. None of the five feature callbacks contains a loop.

No production/helper/schema, admission fixture value, gate exemption or
registry/provider entry is changed. Parent owns source/provider/runtime/live
script acceptance and tracker/delivery state. The parent's sealed GLM R2
`NONE` and old three-DB-case PASS belong to `0fa805fd9`; they do not certify
this test delta. The review budget is complete; no third review was opened.

## Verification and handoff

Local evidence is in
`/tmp/tlp-yuk1445-test-rule-continuation.XOkdkX/`. `start-state.json` records
clean `0c1c`; `case-inventory.json`, `case-inventory.tsv` and `inventory.log`
record case lines, callback hashes and the production comparison. The final
real diff and source/test line receipts are saved alongside the gate logs.

Checks use Node `v24.19.0` from
`/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin` and the existing
cached pnpm `11.13.1`. A temporary launcher keeps nested build commands on
those versions. Corepack lacked its own cached pnpm and was prevented from
downloading it; no installation or network access was used.

- `pnpm vitest run --config vitest.unit.config.ts src/core/schema/assessment/evaluation.test.ts`: 57 PASS, `unit.log`.
- `pnpm audit:test-policy --base 79825bb6d`: 5 checked, 47 inherited, zero errors, `test-policy.log`.
- `pnpm typecheck`: PASS, `typecheck.log`.
- `pnpm lint`: PASS, 172 warnings and zero errors, `lint.log`.
- `pnpm build`: PASS for SPA, Start, server, worker and migrate bundles, `build.log`.

DB tests are prepared but NOT RUN in this lane. DB2 and DB3 changed, so the
old `0fa` three-case PASS cannot be carried forward as a result for the new
cases. Parent must run the changed DB cases in its authorized DB window.
No container, service/runtime, provider, browser, external tracker, child
agent, push, PR or merge operation is part of this continuation. No new
independent actionable follow-up was found beyond these supplied test findings
and the parent's existing DB/runtime acceptance obligations.
