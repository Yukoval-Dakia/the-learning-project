# YUK-1047 placement P1 implementation handoff

Workspace: `/Volumes/YukovalSBak/yukoval-projects/tlp-assessment-entries`.
Branch: `fix/yuk-1047-formal-entries`. Base: `04f0bcaf7`.
This lane is implementation only. Parent owns the sole repair verification review,
Linear capture, runtime acceptance, PR, exact-head CI and delivery.

## Implemented behavior

- Placement start/next issue or recover the same pinned assessment under the
  existing session row lock. `placement:<sessionId>` uses the existing container
  index; deterministic ordinal identities cover issuance/group/submission/key.
  Selection keeps existing KLP/MFI, scope, leanings, pace, cold supply and precision
  rules, and admits only published, available, admitted groups. A composite child
  resolves its published root and only its issued part. No schema migration or
  answer-time publication was added.
- Native progress counts distinct question IDs across historical review/attempt
  and native participation. Accepted originals count even before the participation
  anchor. Pending or held evaluation/settlement blocks cap and new selection.
  Advancing requires the matching effective head and successful settlement;
  `failed_pending`/`replay_required` stays held. Verdicts remain private.
- ScreenPlacement renders the frozen public DTO, native control IDs, math and
  material assets. Original evidence metadata and saved unit targets survive
  restoration. Unsupported controls show an unavailable state and allow exit.
  Correctness/color/rating feedback remains neutral until profile navigation.
- Draft restoration precedes writes. Stable group references, CAS epochs,
  serialized saves and the shared autosave/status controls handle edits, stale ACKs
  and visible conflicts. Conflict recovery explicitly reloads server state before
  local overwrite. Uploads block submit and explicit exit while in flight.
- The URL retains the session ID. Refresh recovers the active issuance; terminal
  sessions never automatically reopen. Pagehide attempts a keepalive flush but
  retains the session and makes no saved claim. Explicit exit awaits an ordinary
  save ACK and the end PATCH, or shows retry/discard choices. Completion awaits a
  successful end PATCH before profile navigation.
- `/attempts` receives the pinned native original with `auto_rate:true`; the
  placeholder `good` rating is not explicit user FSRS input. Existing activation
  owns theta/FSRS. Stored original retries use identical native bytes/IDs; sealed
  held records never redispatch. Only actual persisted native pending receipts
  provide polling handles. Placement remains synchronous by default; no new
  placement durable diversion was introduced.
- API schemas/client types and Postman examples were regenerated. Existing
  placement selection fixtures now use real publication. The v3 subscriber and
  both parent's prior P1 fixes are preserved. The existing native attempt and
  feedback-release actions were also declared in the manifest so generation can
  validate its existing subscriber actions.

Authorization: D11 at
`docs/planning/2026-09-24-question-assessment-decisions.md:80` states:

> - **统一服务端自动保存**：**全部正式练习面**（含 solo+placement）在 **pinned issuance** 上自动保存；状态 saving/saved/error；**只有服务端 ack 才恢复 promise**。

Q20 at line 218
approves UI preflight sections 2–9. Preflight line 114 says
“placement 等待自适应结果”. Component type remains the existing ScreenPlacement
route component (`other`); shared response/status controls are reused, with no
new route, modal or visual redesign. UI files: ScreenPlacement, placement-api,
practice-api/ui-public, EvidenceComposer and AttachmentStrip, plus their tests.

## Passing checks

Every repository command used the absolute workspace above. DB suites used
`DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock` and isolated real
testcontainers. No production DB, paid provider calls or full local test ran.

```sh
pnpm vitest run --config vitest.unit.config.ts \
  src/capabilities/onboarding/ui/ScreenPlacement.lifecycle.unit.test.tsx \
  src/capabilities/onboarding/ui/ScreenPlacement.upload.unit.test.tsx \
  src/capabilities/onboarding/ui/ScreenPlacement.autosave.unit.test.tsx \
  src/ui/hooks/useResponseDraftAutosave.unit.test.ts \
  src/ui/hooks/useJudgeRunPolling.unit.test.ts \
  src/ui/components/response/EvidenceComposer.unit.test.tsx \
  src/ui/components/response/AssetEvidencePreview.unit.test.tsx \
  src/capabilities/practice/api/assessment-contracts.unit.test.ts \
  src/capabilities/practice/server/placement-termination.unit.test.ts \
  src/capabilities/composition.unit.test.ts
```

10 files / **67 tests passed**, exit 0.
Log: `/tmp/yuk1047-placement-unit-pass.log`.

```sh
DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock \
pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/practice/api/placement-api.db.test.ts \
  src/capabilities/practice/api/placement-native.db.test.ts \
  src/capabilities/practice/api/placement-coldstart-e2e.db.test.ts \
  src/capabilities/practice/server/placement-select.db.test.ts \
  src/capabilities/practice/server/placement-scope.db.test.ts \
  src/capabilities/practice/server/placement-starter-recovery.db.test.ts \
  src/capabilities/practice/server/question-supply/placement-starter-store.db.test.ts \
  src/capabilities/practice/api/submit-durable.db.test.ts \
  src/capabilities/practice/api/submit-durable-pending-attempt.db.test.ts
```

9 files / **149 tests passed**, exit 0.
Log: `/tmp/yuk1047-placement-db-pass.log`.
The 12 native tests also passed independently:
`/tmp/yuk1047-placement-native-db-final.log`.

| Command | Result | Log under `/tmp/` |
| --- | --- | --- |
| `pnpm typecheck` | exit 0 | `yuk1047-placement-typecheck-pass.log` |
| `pnpm lint` | exit 0, 328 warnings | `yuk1047-placement-lint-final-pass.log` |
| `pnpm build` | exit 0, all four bundles | `yuk1047-placement-build-pass.log` |
| `pnpm gen:api-client` | exit 0 | `yuk1047-placement-api-gen-final.log` |
| `pnpm gen:postman` | exit 0, 33 folders / 87 paths / 94 requests | `yuk1047-placement-postman.log` |
| `pnpm audit:api-contracts` | 173/173 declared, 0 legacy, 163 paths | `yuk1047-placement-api-contracts.log` |
| `pnpm audit:api-client-usage` | exit 0 | `yuk1047-placement-api-client-usage.log` |
| `pnpm audit:capability-boundaries` | exact 437/0/48, unchanged baseline | `yuk1047-placement-boundaries.log` |
| `pnpm audit:draft-status-reads` | exit 0, existing deferred reads unchanged | `yuk1047-placement-draft-status-reads.log` |
| `pnpm audit:schema` | 882 fields, 0 unallowed stubs | `yuk1047-placement-schema-audit.log` |
| `pnpm audit:partition` | no P0/unmatched files; 5 existing warnings | `yuk1047-placement-partition-audit.log` |

`pnpm audit:api-client` and `git diff --check` also passed at the staged checkpoint;
their logs are `/tmp/yuk1047-placement-api-client-audit.log` and
`/tmp/yuk1047-placement-diff-check.log`.

Offline model-port tests establish plumbing and recovery, not real provider output
quality or production admission.

## Remaining gate repair evidence

The bounded gate repair starts at `573765a9b4e3f570a37c61fb5156a7166b98d7fc`.
The previous failure and attribution logs above remain historical evidence.
Both assigned gates are now repaired. No claim-release production behavior changed.

1. The old durable-resource assertion expected `draft_status=active` after 429.
   That expectation contradicts the saved-original contract documented in
   `2026-10-04-yuk1047-formal-entry-migration.md:332`: same issuance/group/key retries
   recover the original, while changed answers and second identities are rejected.
   `submit.ts` claim release excludes any persisted submission for the question
   group; durable dispatch saves that submission before rate admission.
   The replacement test uses real publication with `claimPolicy=one_time`, actual
   issuance, HTTP submit, persisted originals and the native worker. It verifies:
   - 429 keeps the exact native original and the claimed issuance; there is no
     pending receipt, candidate or model execution yet.
   - A second issuance is `claim_unavailable`; changed bytes or an independent
     idempotency identity receive 409 without replacing the original.
   - After rate-limit reset, the same original returns 202; repeated HTTP delivery
     uses the same pending submission and adds no queue delivery.
   - Worker execution and redelivery preserve all issuances and original bytes,
     create one candidate, one participation anchor and one model-execution claim,
     and call the offline recorded model port exactly once.
   The scoped worker suite exposed the same stale `active` assertion after a model
   failure. Its updated test verifies that the original and draft claim remain,
   redelivery makes no second execution claim or model call, and FSRS stays empty.
   No paid provider calls were made.
2. Removed all 25 branch-added `noNonNullAssertion` warnings with captured narrowed
   values or explicit test presence guards. Evidence restoration performs one
   lookup, the verdict reader supplies its existing null verdict shape when absent,
   and the frozen criterion projection has an exhaustive return. Removed the new
   unused read-model type and the obsolete paper-effect suppression. All edited
   code files belong to the diff from
   `6e5d93ac337b89a7732cda71d68352f5d1385f13` to starting HEAD.
   `pnpm lint:ratchet` passes at **299 warnings / 0 infos**, below **305 / 0**.
   The initial JSON identified four rule increases: 25 non-null assertions, one
   unused variable, one unused suppression and one iterable callback return.
   These increases were removed structurally. The baseline was not changed and
   no new suppression was added. Existing unrelated warnings remain.

| Bounded check | Result | Log under `/tmp/` |
| --- | --- | --- |
| Scoped DB, 11 files | 105 distinct tests pass across the initial run and repair run | `yuk1047-gate-db.log`, `yuk1047-gate-db-corrected.log` |
| Scoped unit, study context and paper capture/native/autosave | 4 files / 57 tests pass | `yuk1047-gate-unit.log` |
| `pnpm typecheck` | exit 0 | `yuk1047-gate-typecheck.log` |
| `pnpm lint:ratchet` | exit 0, 299 warnings, unchanged baseline 305 | `yuk1047-gate-lint-ratchet.log` |
| `pnpm build` | exit 0, Vite and server/worker/migrate bundles | `yuk1047-gate-build.log` |
| Touched Biome formatting and `git diff --check` | exit 0 | `yuk1047-gate-biome-touched.log`, `yuk1047-gate-biome-corrected.log` |

The initial DB run passed 103/105. The new fixture first expected `published`
instead of the correct `admission_updated` lifecycle transition, and the worker
suite exposed the stale claim-release assertion described above. Only those two
files were rerun after correction: **27/27 passed**. Already passing checks were
not repeated. Typecheck, lint and build each ran once; subsequent corrections
were confined to those two tests.

DB tests used their own disposable testcontainers with
`DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock`. Parent API/Vite port
18789 and DB port 18790 were not controlled or altered. `.serena/project.yml`
remains unrelated and unstaged. No delegation, formal review, full local test,
push, PR, deployment or paid calls ran in this lane. No separate actionable
follow-up was created; these are repairs to the existing YUK-1047 contract.

Parent still owns browser/runtime acceptance, the sole repair verification
review, Linear capture/status, PR and exact-head CI. YUK-1047 remains open.
The writer is released after this lane's evidence commit.

## Parent's no-paid-call runtime fixture

Use the parent's explicitly isolated, migrated disposable database and API/Vite
runtime, not any production/NAS database. `seedPlacementRuntimeFixture` is in
`tests/fixtures/assessment-placement.ts`. It creates a synthetic explicit goal,
one KC and eight truly published/admitted **local exact** questions. It returns
goal/KC/question IDs and the placement route. The native DB test exercises all
eight through real submit/next handlers and verifies zero model execution claims.

From the absolute workspace above, set `PLACEMENT_FIXTURE_DATABASE_URL` to that
disposable database and run:

```sh
DATABASE_URL="${PLACEMENT_FIXTURE_DATABASE_URL:?set an isolated disposable database URL}" \
pnpm tsx -e 'import { db } from "./src/db/client"; import { seedPlacementRuntimeFixture } from "./tests/fixtures/assessment-placement"; seedPlacementRuntimeFixture(db).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$client.end());'
```

The parent's API process needs `PLACEMENT_PROBE_ENABLED=true` and the same
disposable DB. Keep provider settings unchanged. Open the returned route on that
Vite instance; each exact answer is `fixture answer`. Try long text + autosave,
refresh the URL (same session/issuance/slot IDs), then replace with the exact text
and submit. Answer eight questions to exercise server counts and completion ACK.
Use two tabs to provoke CAS conflict and explicitly reload server state. Test exit
with a save failure/upload in flight and bfcache/pagehide without abandoning the
session. The fixture is text-only; native media/control/pending/held cases have
scoped evidence above but still need any additional runtime acceptance parent
requires. Do not infer provider quality from the synthetic exact fixture.

No dev server was started in this lane. All owned test/build/generation processes
finish before handoff; code + DB/build ownership returns to parent. Unrelated
`.serena/project.yml` remains unmodified and uncommitted by this lane.

## Parent acceptance and sole repair verification

On 2026-10-05 the parent ran the built app against its isolated migrated
Postgres fixture on ports 18789/18790. The database epoch was explicitly
initialized through the official CLI. No production database or provider was used.

- Real Chrome UI saved 962 characters including Chinese, newlines and symbols,
  then recovered the same text and session URL after refresh.
- Eight local-exact answers submitted successfully with HTTP 201. Native progress
  advanced through all eight and completion navigated to `/profile`; no page errors.
- Two tabs produced a real CAS 409. Explicit reload restored the server draft.
- A deliberately intercepted draft request returned 503. Exit remained blocked;
  after removing interception, retry saved and ended the session before `/today`.
- Harness corrections: draft writes use POST, and initial attempts return 201.
  Earlier harness expectations of PUT/200 failed; these were not product failures.

Logs: `/tmp/yuk1047-runtime-accept.{log,json}` and
`/tmp/yuk1047-runtime-conflict.{log,json}`. Screenshots:
`/tmp/yuk1047-runtime-restored.png`, `yuk1047-runtime-complete.png`,
`yuk1047-runtime-save-failure.png`. Synthetic text-only local-exact acceptance
does not establish model output quality or image interpretation.

The sole repair verification reviewed `c53c8e189..f6f8f638a`, confirmed all three
original P1s resolved and found no new P0/P1. It independently passed 30 focused
unit tests and inspected the DB regressions without rerunning them. Both parked
P2s remain unfixed. Initial plus repair review budget is exhausted.

Latest `origin/main` tooling-only changes merged without conflict as `bb269d9aa`.
Assessment source and test configurations were unchanged. Parent reran build
and agent-control-plane/skill-mirror audits successfully. PR [#1568](https://github.com/Yukoval-Dakia/the-learning-project/pull/1568)
is open and linked to T3. Exact-head CI and the last-push merge window remain pending; YUK-1047 remains open. No deployment or paid calls.

The parent stopped its isolated API and removed its disposable runtime database
container after acceptance. Screenshots and logs remain under `/tmp/`.


## PR #1568 remaining exact-head CI repairs

Implementation-only lane on 2026-10-05, starting at parent commit
`226cca21ff09d504528cbeb081a1b324c5d81151`. Parent had already repaired the
separate audit count failure. This lane addressed the remaining **9 failed tests
in 7 files** from PR head `4a59b5821055838449f65e59a69cf3fb405039ea`.
The supplied raw log records GitHub's merge checkout `c633d0be`; it is not a
new verification of the repair commit. Sources:
`/tmp/yuk1047-ci-failed.log` and `/tmp/yuk1047-ci-failed-clean.log`.

Original failures reproduced unchanged: 2/24 unit failures and 7/58 DB failures,
plus the advisory-lock test's unhandled connection-close error. Logs:
`/tmp/yuk1047-ci-repair-unit-red.log` and
`/tmp/yuk1047-ci-repair-db-red.log`.

| Failure owner | Cause and preserved guarantee |
| --- | --- |
| `resource-routes.unit.test.ts` | `regenerate` is no longer a valid solve creation field. Forward the actual `issuance_id`, retaining 201, Location and question-path authority assertions. |
| `step9-invariant-audit.test.ts` | Native `assessment-capture.ts` was absent from the sanctioned writer inventory. Its existing block UPDATE and lifecycle event share the activation transaction. Register that owner, with real enrollment/revert fold parity below. The invariant still rejects every unsanctioned writer. |
| `parity-writers-c3.db.test.ts` | Old enrollment used a nonexistent `asset_1` and legacy mistake-result injection; old revert omitted the actual attempt link. Create trusted asset metadata, persist a real frozen capture, explicitly publish its local deterministic fixture reference, then run native auto-enrollment and its real withdrawal. Both lifecycle transitions preserve imported links, version increments and byte-for-byte fold/live parity; the linked learning record is archived on revert. |
| `advisory-locks.db.test.ts` | Legacy submit bodies were rejected before reaching learning writes. Real published/issued answers still wait behind the separate connection's global lock for the original 600 ms probe, then write FSRS and theta. Six submit/merge races retain the caller subset versus frozen superset and real merge writers, require successful effective correct/incorrect results, and reject deadlocks. Failed assertions now release and drain the lock holder before closing its connection. |
| `make-paper.db.test.ts` | Direct session opening did not freeze paper issuances; direct legacy slot submission omitted the original assessment. Use the existing frozen-paper helpers and explicit local exact reference. The closed loop retains list/slot/feedback/FSRS assertions and now checks both opening issuances, native participation, independent evaluation, original submission, effective head and activation links. |
| `appeal.enqueue.db.test.ts` | An isolated historical judge event has no frozen native original and correctly receives 409. Appeal a real effective native evaluation. Keep the exact singleton key/window send assertion and verify its persisted evaluation target and expected head. This remains an enqueue-options test, not a real pg-boss dedup execution claim. |
| `proposal-appliers.db.test.ts` | Structural active status does not confer automatic scoring admission. Preserve the no-KC match, new approved child KC and absent OCR reference assertions, then verify withheld means unselectable. Author a reviewed local choice key through the existing question editor, run actual source verification/publication with offline solver/grounding ports, and prove placement selection, native issuance, correct evaluation and effective activation. No direct lifecycle/admission-row writes or invented model slice. |

The cold-start source fixture now contains a longer multi-line quadratic problem,
with factorization, both roots and substitution requirements. The initial short
fixture failed the existing source-consistency overlap check, **0.12 < 0.15**,
when compared with its raw VLM JSON envelope. The richer source fixture passes
that unchanged check; the raw-output provenance policy and independent image
verification remain intact. Missing references still require review before
admission. Offline solver/grounding ports establish wiring, not paid-provider
quality or production model admission.

No production behavior repair was required after valid frozen inputs reached the
real writers. The only non-test code change is the event-native writer inventory.
No legacy scoring fallback, admission bypass or audit allowlist was added.

### Final scoped evidence

All DB commands used disposable testcontainers and
`DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock`.

| Check | Verified result | Log under `/tmp/` |
| --- | --- | --- |
| Scoped unit: resource routes, Step 9 invariants and fold-write scanner | 3 files / **51 passed**, exit 0 | `yuk1047-ci-repair-unit-pass.log` |
| Native enrollment/revert parity and appeal enqueue | 2 files / **13 passed** in the first repair run | `yuk1047-ci-repair-db-first.log` |
| Advisory locks and make-paper closed loop | 2 files / **18 passed** in the second repair run | `yuk1047-ci-repair-db-second.log` |
| Image-candidate proposal appliers, including cold-start issue/submit/activate | 1 file / **27 passed**, exit 0 | `yuk1047-ci-repair-coldstart-pass.log` |
| `pnpm typecheck` | exit 0 | `yuk1047-ci-repair-typecheck-final.log` |
| `pnpm lint:ratchet` | exit 0, **298 warnings / 0 infos**, baseline unchanged at 305 / 0 | `yuk1047-ci-repair-lint-ratchet.log` |
| `pnpm build` | exit 0, Vite + server/worker/migrate bundles | `yuk1047-ci-repair-build.log` |
| Biome on touched source files; `git diff --check` | exit 0; four existing warnings only | `yuk1047-ci-repair-biome-final.log` |

These are **58 distinct DB tests**, not a sum of repeated executions. The first
repair command passed 29/31 but exposed an intermediate fixture insertion mistake
and the paper's missing explicit exact policy; the second passed 44/45 with only
the cold-start fixture still failing. After corrections, only the still-failing
cold-start file was rerun, all 27 passed, and all required gates passed. The final
runs contain no unhandled rejection. Already passing files were not rerun for a
single combined green log.

Parent owns tracker capture/status, PR linking, push and fresh exact-head CI.
No independent review was started; its budget remains exhausted. No full local
test, delegation, paid call, production access, PR/comment or push ran here.
There is no separate actionable follow-up from this bounded repair; these fixes
belong to the existing YUK-1047 task. `.serena/project.yml` remains unrelated and
unstaged. Writer ownership returns to parent after this lane's evidence commit.

Parent acceptance of the CI repair: inspected the actual fixture and writer
inventory diff, verified the native block update and lifecycle event share the
activation transaction, independently reran 24 resource/invariant unit tests,
27 fold scanner unit tests, and 22 parity/global-lock DB tests; all passed.
Logs: `/tmp/yuk1047-parent-ci-repair-{unit,scanner,db}.log`. This is author
acceptance, not an additional independent review round.

## Follow-up CI ownership repair

CI run 37302850917 on 163d3b71d found one new ownership assertion:
`proposal-appliers.db.test.ts` imported Practice's private source verification
job directly. Expose the existing `runSourceVerify` through Practice's public
module and consume that seam in the ingestion test. No verification behavior,
fixture assertions, or ownership scan rules change. The real cold-start flow
still runs source verification and publication. Scoped ownership tests (3) and
cold-start DB suite (27) passed; capability boundaries remain exact 437/0/48.
Logs are `/tmp/yuk1047-ci2-{ownership,coldstart,typecheck,build,biome}.log`.

Typecheck and build passed after this import-seam change. Touched-file Biome
reported no errors and one existing warning. No extra review or provider calls.
