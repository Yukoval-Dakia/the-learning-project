# Choice entry P1 repair disposition

This is the implementation response to the two verified P1 findings against
`c4c898b94903040063447208aa5d1245ff2f3ae8`, on
`feat/yuk-1445-choice-entry-publication`, base
`79825bb6da73f9894c65a5d6735e3725f098e8e1`. The initial Astra high report remains
at `/tmp/yuk1445-choice-entry-initial-review-k3max.md`, SHA-256
`129567ba26e580604b2caddb92b3876a1ead5eab04c9d5c8090e9c8fa625c43e`.
Its filename does not identify the executing model as K3. This repair does not
consume the parent's remaining verification review or supersede earlier failed
quota, review, serving or runtime evidence.

## P1a: reject unsupported edits and raw row disagreement

The original pure normalizer was executed under Node 24.19.0 for `2+4=?`, then
with only `prompt_md` changed to `2+5=?`, then with only `choices_md` changed.
Both edits returned the original frozen prompt/options and unchanged integrity
digest. The reproduction deliberately failed and its original log is retained.
The same probe now rejects both desynchronized inputs.

The first slice explicitly rejects semantic edits to an existing typed choice
entry. `editQuestion` throws the existing typed `ApiError` with code
`choice_entry_recalibration_required`, status 409 and a re-entry/calibration
message before any UPDATE or edit event. The existing transport error adapter
returns that message; no route changes are needed. A patch containing other
changes rolls back as a whole. Unchanged fields, difficulty and knowledge edits
retain their existing behavior. Legacy rows without `structured.assessment`
retain their existing edit and normalization paths.

`normalizeQuestionRowBase` independently rejects mismatched typed row prompt,
ordered option text, kind or standalone structure. It never assigns option ID
continuity from a label, index or changed text. `readVerifiedChoiceEntry` returns
unavailable for invalid current rows or stale calibration, so source verification
fails without borrowing the old entry proof. The canonical row publisher also
checks the raw row and source bindings before an admitted publication. No
historical revision, issuance, submission, accepted/pending/held record, or
Judgment is rewritten.

## P1b: separate source consistency check

After the two independent blind solves agree, `prepareSingleChoiceEntry` invokes
the same central `ChoiceEntrySolveTask` in explicit `source_crosscheck` mode when
the captured source answer is nonblank. It uses a fresh context and strict
`consistent | conflict | unknown` output. Conflict and unknown throw typed
`choice_entry_source_conflict` / `choice_entry_source_unknown` errors before
`store_sourced_question` enters its canonical insert transaction. A malformed
result, missing successful real receipt or reused blind receipt also rejects.
There is no source-answer regex or text-to-key parser in this check.

The two blind requests still contain only the captured question, stable options,
identities and printed points. Neither gets source prose, the other answer,
learner work or replay. Cross-check mode receives the original source answer,
URL/title/extract/hash and the agreed proposal only after both solves finish.
One task kind is reused; the released task catalog remains at 56, with no census
or catalog edits in this repair.

The existing calibration evidence now retains the cross-check input/output,
attributable raw source reference, task-run ID, actual provider/model and both
digests. Successful receipt input hashes are checked against the actual input.
Raw row bindings include prompt, choices, reference, structured inputs, rubric,
judge override and source identity. Source provenance content is separately
checked; unrelated metadata does not invalidate proof. Publication and source
verification require this evidence to cover the current row, frozen question
and key. Source verification checks all three successful receipts when a source
answer exists. Historical evidence remains schema-readable, but missing new
bindings cannot satisfy prospective entry validation. No second evidence store,
writer, lifecycle or grading path was added.

The entry stamps the already-derived `exact` override explicitly and sanitizes
the worked solution before sealing the row, matching the existing sourced insert
behavior. Cross-check success does not prove model or automatic-judge admission.
The parent must budget three physical calls for a nonblank source answer, two
when blank, and retain normal reserve/unknown-cost rules.

## Verification and retained limits

All local commands use
`PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH` and pnpm 11.13.1.
Logs are retained in `.cache/yuk1445-choice-p1-fix/` in this worktree.

- `pnpm exec tsx .cache/yuk1445-choice-p1-fix/stale-row-reproduction.ts`: original
  c4c failure in `original-c4c-stale-row.log`; repaired rejection in
  `fixed-stale-row.log`.
- `pnpm vitest run --config vitest.unit.config.ts src/core/schema/assessment/evaluation.test.ts`:
  62 passed in `unit-attempt-2.log`. `first-unit.log` retains two failed test
  expectations from the first repair run; they were corrected, not erased.
- `pnpm typecheck`: passed in `typecheck-attempt-2.log` for the repaired source.
- `pnpm lint`: passed, 172 warnings, in `lint-attempt-1.log`.
- `pnpm build`: passed in `build-attempt-1.log` for the repaired source.
- `pnpm audit:test-policy --base c4c898b94903040063447208aa5d1245ff2f3ae8`:
  6 changed/new cases admitted, zero errors in `test-policy-precommit.log`.
  The final fixed-SHA audit receipt is retained separately after commit.

Unit assertions exercise the real pure normalizer/evaluator and calibration
admission checks. Fixture cross-check verdicts test conflict gating and source
binding; they are not evidence of provider output or model quality.

The existing publisher DB file now also covers whole-patch edit rollback,
unchanged/metadata edits, raw prompt/options/reference/source changes, and stale
key proof. It was updated and typechecked, not executed. The parent's original
c4c two DB passes do not validate this repair. The parent owns fixed-head DB
execution, the one remaining independent verification review, real entry/provider
acceptance, cost wrapper, issuance and submission/grading acceptance.

No full test, DB, Docker, service runtime, browser, provider, paid call, network,
shared lock, credential/config change, push, PR, merge, deployment or child was
used. The five matching/sentence-break core files remain untouched. Linear and
shared planning handoff remain parent-owned under this explicit offline scope;
no new actionable finding beyond the two assigned P1s was discovered here.
