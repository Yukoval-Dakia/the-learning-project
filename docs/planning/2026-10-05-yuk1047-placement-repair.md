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

## Late advisory P1: derived reference reveal

Codex comment 4183568332 identified a real reveal regression after CI passed.
The frozen context derives reference text from scoped scoring criteria, but the
reveal endpoint returned only separate solution material. A real published/issued
choice fixture without solution material reproduced HTTP200 with reference null
instead of frozen `B. 乙`, despite the scoring basis holding the answer.
The regression edits current-row answer/options after issuance and checks both
the frozen response and the assistance receipt digest.

Reveal now returns `context.reference_md` and records that exact content as
answer-help before returning. Existing complete solution material still has
priority; disclosure guards remain unchanged. RED:1failed/33skipped, then full
submission persistence DB34passed and study-context unit16passed. Typecheck and
lint298≤305 passed. Logs: `/tmp/yuk1047-reveal-{red,green,unit,types,lint,build}.log`.
No additional independent review round was started; this is author repair of a
validated P1. The repeated PfSolo autosave P2 remains deferred as already tracked.
New push requires fresh exact-head CI and a new17-minute merge window.

Build evidence: Vite passed in the initial build. Server esbuild then stalled
while reading directories for about three minutes; parent captured a process
sample and terminated that attempt. Retrying server, worker and migrate bundles
succeeded (exit0), recorded in `/tmp/yuk1047-reveal-build-retry.log`. All four
bundles completed; the interrupted attempt is not counted as passing.


## Bounded repair of the three latest PR1568 findings

Implementation lane starts at `ed53594cd` in
`/Volumes/YukovalSBak/yukoval-projects/tlp-assessment-entries`. Parent released
writer ownership; this lane runs no delegation or review round. Parent retains
PR/tracker/CI/delivery ownership. The performance-only
`getCurrentFailureAttempts` comment 4183803000 is excluded;
`failure-attempts.ts` is unchanged.

Existing UI authorization remains Q20 / D11, with
`docs/design/2026-09-24-assessment-ui-preflight.md` sections 2–9 approved.
Section 2 says "共享作答组件为**现有 route 内的 other**". Section 3 says
"默认绑定当前 evaluation group，**关联子集可编辑**". PfSolo remains the
existing component; only `PfSolo.tsx` and its interaction test change in the UI.
There is no new UI concept or route.

### Reproduced failures and corrections

- **Solo response coverage.** The real PfSolo component enabled final submission
  after answering only the first of two issued deterministic slots. RED is the
  `photo=false` case in `/tmp/yuk1047-latest-solo-red.log` and
  `/tmp/yuk1047-latest-solo-red-final.log`. The initial photo fixture had an upload
  URL/attachment-label error; those failures are not counted as causal evidence.
  Automatic submission now requires every issued non-table slot to be answered
  or covered by the evaluator's permitted evidence substitution. The frozen
  public DTO projects opaque slot/unit input requirements from the actual scoped
  basis and executor assignments, without criteria, executor descriptors, task
  names or admitted slice IDs. Missing public requirements never imply a model
  assignment. Whole-group and complete scoped model evidence retain photo-only
  submission; partial scoped evidence and photos over missing deterministic
  responses remain blocked. Explicit manual practice retains partial evidence
  and self-rating. API client types were regenerated.
- **Probe GET writes.** An admitted but unissued probe acquired a permanent
  `iss_probe_*` row and claim during GET. The DB RED log below shows the new row.
  Shell now only reads persisted issuance and its pinned revision. Agency's
  production serve path owns issuance; its registered publication subscriber
  invokes the same delivery command when later admission becomes available.
  Withheld probes remain hidden and unissued. Existing issued probes replay their
  original revision even after a newer revision is published. Answered probes
  cannot acquire a new issuance. No endpoint was added. Postman regeneration
  completed with no artifact diff.
- **Paper original/capture race.** Separate connections held the session row
  while submission ran, then let completion, abandonment or a reopened occurrence
  win. All three produced an accepted immutable original without capture before
  the repair. The submission, draft clearing, participation receipt and answer
  capture now commit in one transaction under the learning/session/occurrence
  locks. Terminal wins retain the draft and accept no new original. Submission
  wins retain capture across completion and immutable retries. `Db | Tx` helpers
  reuse the transaction; evaluation/model work remains outside it. Paper
  activation locks the session before group/root locks, preserving the common
  learning-lock order and avoiding a capture/activation inversion. Concurrent
  duplicate submissions share one original and capture.

### Scoped verification

All DB runs use disposable testcontainers and
`DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock`. No full `pnpm test`,
provider payment, production access or external delivery ran.

| Check | Result | Exact log under `/tmp/` |
| --- | --- | --- |
| GET mutation + completed/abandoned/reopened races, before repair | 4 failed, 7 skipped | `yuk1047-latest-db-red.log` |
| Final PfSolo interaction, DTO privacy/requirements, core evaluation and manifest unit suites | 4 files / 146 passed, exit 0 | `yuk1047-latest-unit-final.log` |
| Paper issuance/provenance and Agency lifecycle regression suites | 36 passed in the first six-file run; no failures in those three files | `yuk1047-latest-db-green.log` |
| Final concurrent/race and full probe-answer suites | 32 passed; the reader suite alone had a new test import error | `yuk1047-latest-db-final.log` |
| Reader suite after fixing that test import, including actual GET purity and later publication replay | 7 passed, exit 0 | `yuk1047-latest-probe-reader-final.log` |
| Registered publication handler: withheld, then admitted, serve, read, answer, duplicate delivery | 1 passed, 26 skipped in the focused repair run; also passed in the final full answer suite | `yuk1047-latest-delayed-probe.log` |
| `pnpm typecheck` | exit 0 | `yuk1047-latest-typecheck-pass.log` |
| `pnpm lint:ratchet` | exit 0, 298 warnings / 0 infos, baseline 305 / 0 unchanged | `yuk1047-latest-lint-pass.log` |
| Final `pnpm build` | exit 0; Vite and server/worker/migrate all complete | `yuk1047-latest-build-final.log` |
| API client / Postman generation | exit 0; client requirements added, Postman unchanged | `yuk1047-latest-gen-api.log`, `yuk1047-latest-postman.log` |

These are **75 distinct passing DB tests across scoped runs**, not the sum of
repeated executions. The first broad DB run had a new offline signature-fixture
failure; the final reader run had a wrong digest-helper import. Both were fixed
and their affected suites rerun. All final affected suites are green. The first
34-unit run was superseded by the final 146-unit run. No unhandled rejection
remains in the final logs.

The final server build took about 150 seconds; worker/migrate took about 23/9
seconds. The earlier complete build took about 216/41/45 seconds for those three
bundles. Process samples under `/tmp/yuk1047-latest-{esbuild,vitest}-sample.txt`
show filesystem stat/read activity during the long waits. Neither build is
reported as interrupted. Bundle-size warnings are unchanged advisory output.

Offline recorded model ports validate the original/capture/claim and probe
signature wiring. They do not establish provider quality or production model
admission. The registered publication handler was exercised through its real
manifest loader; this lane did not operate a production worker or a live browser.
Parent owns any additional runtime acceptance and external delivery.

No new independent actionable follow-up was found beyond these existing YUK-1047
findings. Parent owns Linear capture/status. `.serena/project.yml` is preserved
and excluded from the commit. Writer ownership returns to parent with the repair
commit; this lane stops after reporting its result.

Parent acceptance of 1c1401022: inspected the actual lock ordering, public
response requirements, Agency delivery/subscriber, and shell read-only diff.
Independently reran 34 PfSolo/DTO unit tests and 12 paper race/Probe reader DB
tests, all passed. Capability boundaries, API contract and regenerated-client
consistency audits passed. Logs: `/tmp/yuk1047-parent-late-{unit,db,audits}.log`.
These checks exercise real components and database handlers; no new browser or
production worker acceptance is claimed. No additional independent review ran.

Performance comment 4183803000 is deferred as P2 under the owner policy: the
unbounded historical load is confirmed, but no measured timeout or result error
was supplied. It is recorded in YUK-1047/PLAN PARKED with bounded keyset and
corrected-prefix/per-question regression acceptance. It remains unfixed.

## CI 37314297861 repair of the eleven e1d5f651c failures

This bounded writer started from `80d1ccb0965098c5ca6c8b109664accefc17f1ed`
in `/Volumes/YukovalSBak/yukoval-projects/tlp-assessment-entries`. The original
CI failure log is `/tmp/yuk1047-e1-ci-failed.log`. All eleven reported failures
were reproduced before edits: two unit failures and nine DB failures.

### Causes and corrections

- `projectPracticeIssuance` used `projectIssuedScoringBasis` merely to obtain
  units for public response requirements. That helper also rejects partial
  `capped_sum` and `threshold_levels` scoring. Consequently a legal partial
  public issuance threw, and native CSV reporting caught the DTO failure and
  excluded the entire joint group, producing zero rows instead of two.
  The DTO now selects units only when all their response and evidence slots
  belong to the issued answerable slot set. Aggregation is untouched. Existing
  CSV expectations are unchanged. New DTO regressions verify both policies,
  cross-scope evidence exclusion, private rule/executor exclusion, and the
  continuing partial-scoring prohibition. The original P1-6 scope assertion
  also verifies that public projection succeeds while scoring still rejects.
- The real registry now contains `agency.probe-publication-serve@1`. Backup
  fixtures still required four subscribers, so four backup tests stopped at
  their obsolete registry assertion. The fixture now requires all five exact
  identities/versions, all five declaration hashes, and 35 deliveries covering
  seven states per subscriber. Restore lease fencing, retry history, terminal
  and effect idempotency, paused state, and transactional rollback assertions
  remain in place.
- The research closed-loop fixture admitted its probe through
  `publishPaperModelFixture`, then called `loadActiveProbes` to serve it. The
  reader is intentionally read-only. No issuance existed, so the real answer
  route correctly returned 409 in five cases. The fixture now bootstraps the
  real registered publication subscriber before admission and runs its actual
  durable dispatch cycle. It verifies the admitted publication's delivery is
  `succeeded`, the issuance exists, and reads leave issuance rows unchanged
  both before and after delivery. Only then does it call the existing Hono
  answer route. Publication, checkpoint/discovery/claim/completion, issuance,
  native judging and reconciliation are real code; the existing offline model
  adapter remains the only replaced model port. No GET writer was restored.

Production changes are confined to `src/core/schema/assessment/dto.ts`.
The other changes are its contract/DTO tests, the two failing DB fixture files,
and this evidence document. `csv.test.ts` required no edit. Placement, PfSolo,
PLAN, `.remember`, and the external `.serena/project.yml` change were untouched.

### Verification and remaining blocker

Every log below is under `/tmp/` with the prefix `yuk1047-e1-ci-repair-`.

| Check | Result | Log suffix |
| --- | --- | --- |
| Original contract + CSV unit RED | 2 failed, 56 passed | `unit-red.log` |
| Original backup + closed-loop DB RED | 9 failed, 17 passed | `db-red.log` |
| Contract + DTO + evaluator + CSV unit | 158 passed, 4 files | `unit-green.log` |
| First repaired backup + closed-loop DB | 26 passed, 2 files | `db-green.log` |
| Final backup + closed-loop + Probe API/lifecycle + shell reader DB | 85 passed, 5 files | `db-final.log` |
| Changed-file Biome | exit 0, no errors/warnings | `biome-final.log` |
| `pnpm lint:ratchet` | exit 0, 298 warnings within 305 baseline | `lint-ratchet.log` |
| `pnpm build` | exit 0, web/server/worker/migrate built | `build.log` |
| API contracts/client/client usage | all exit 0, generated client unchanged | `audit-{api-contracts,api-client,api-client-usage}.log` |
| Capability boundaries | exit 0, 437/0/48 unchanged | `audit-capability-boundaries.log` |
| Structured judge/partition/schema/task census | all exit 0 | `audit-{structured-judge,partition,schema,task-census}.log` |
| `pnpm typecheck` | exit 1, three existing Placement fixture errors | `typecheck.log` |
| Starting HEAD compiler reproduction | exit 1, identical three diagnostics | `typecheck-baseline.log`, `typecheck-comparison.log` |

The final counts are **158 distinct unit tests and 85 distinct DB tests**.
The 26-test DB run is included in the final 85, not added to it. DB runs used
`DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock` and isolated testcontainers.
No full local test suite, independent review, live model call, deployment,
PR communication, push, or user-service interruption ran in this lane.

Typecheck remains blocked at
`src/capabilities/onboarding/ui/ScreenPlacement.coverage.unit.test.tsx` lines
253, 338 and 386. Its three draft fixtures omit `evaluation_group_ref` and
`updated_at`, required by the existing generated response contract. A clean
`git archive` snapshot of the starting HEAD, using the checkout's existing
`node_modules/.bin/tsc --noEmit`, produced the exact same three diagnostics;
`typecheck-comparison.log` records equality. The snapshot path is recorded in
`baseline-path.log`. The snapshot's first pnpm invocation refused dependency
purging without a TTY; that attempt is preserved in `baseline-preflight.log`.
The active dependency tree was not purged.

The parent task brief explicitly excluded Placement edits from this writer's scope, so no
fixture workaround or type relaxation was made. Parent must repair those
three fixtures and rerun typecheck before claiming all local gates green.
There is no remaining failure among the eleven assigned CI tests. These are
local results; exact-head CI and external delivery remain parent-owned.
Parent also owns Linear capture/status for the existing YUK-1047 repair.
No new unrelated follow-up was introduced. Writer ownership returns to parent
with this repair commit, and this lane stops after reporting its result.


### Parent acceptance after CI and Placement repairs

Placement coverage commit `80d1ccb09` passed its five causal RED assertions and
36 scoped component tests. Parent independently reran the 15 new coverage tests.
The three draft fixtures were then completed with `evaluation_group_ref: null`
and a fixed `updated_at`; no runtime contract was relaxed.

On top of `88f6ba36d`, parent inspected the DTO unit scope and the real durable
publication delivery used by the closed-loop fixture, then independently passed
98 unit tests across Placement coverage, DTO, assessment contract and CSV, plus
26 DB tests across backup/restore and the research closed loop. Typecheck and
lint:ratchet passed, with 298 warnings within the unchanged 305 baseline.
Logs: `/tmp/yuk1047-parent-final-{unit,db,typecheck,lint}.log`. The lane build
and eight audits passed before the fixture-only parent edit.

Previous solo/probe/paper review threads were replied to and resolved after
their pushed repair. Placement review remains to resolve after this push.
Exact-head CI and the 17-minute last-push window still gate merge. Existing
three P2 follow-ups remain on YUK-1047; no additional issue, independent review,
production deployment or paid provider call was introduced.

## Paper feedback repair for late P1 comments 4184804038 and 4184804047

This writer started at `2164c4247c837d7ff738a990b213f8017124ee33` in
`/Volumes/YukovalSBak/yukoval-projects/tlp-assessment-entries`, branch
`fix/yuk-1047-formal-entries`. Scope is the two paper read implementations,
their DB regressions and this evidence append. Parent owns final acceptance,
push, PR replies and tracker status.

### Causal evidence and correction

The initial 41-test DB run passed despite the missing read-side guards. Source
and runtime inspection explained both blind spots. Row normalization creates
private `sol_*` materials even for a simple answer, so those fixtures never
exercise a reference supplied only by the scoring basis. Also,
`resolveVerdictsForNativeAttempts` already hides grades when the capture carries
`paper_feedback_policy=judge_now_show_later`. Normal fully annotated captures
therefore do not reproduce the summary leak. The capture schema makes this
annotation optional; it cannot replace the immutable opening receipt's policy.

The new test-local publication helper removes solution materials before real
publication, updates the contract digest, and retains the deterministic text
criterion. Tests inspect the actual issued revision to prove that no `sol_*`
material exists and that its scoring basis still holds `true`. They then use
real publication, issuance, submission, evaluation, activation, detail HTTP and
list HTTP code. Partial grades use the existing real manual correction/CAS
helper. No model port or verdict resolver is mocked.

Buffered fixtures also omit the optional capture-policy annotation using an
explicit DB fixture update. Frozen submission/issuance/revision identities and
the opening receipt stay intact. This isolates whether the paper reads enforce
the receipt themselves. The current normal submission producer continues to
populate the annotation. No ordinary fully annotated producer leak is claimed.

Before either product edit, the verified causal run reported **8 failed and
33 passed DB tests**. It exposed null references for immediate and completed
submissions without solution materials, plus buffered right/wrong leakage in
started and paused detail/list summaries. The same cases pass after these fixes:

- Detail returns the existing frozen `context.reference_md` projection, matching
  study reference reveal and preserving complete solution material precedence.
- Detail counts right/wrong only when the slot is visible. List native counting
  independently checks the matching frozen slot's policy and session completion.
  Both preserve submitted progress in `pos`; correct/partial still count as
  right, incorrect as wrong, and absent/unresolved adjudications count as neither.

Six matrix cases cover immediate/buffered and correct/incorrect/partial across
started, paused and completed, followed by a completed reload. They edit the hot
question prompt/reference and replace the paper's hot policy after opening,
then assert the frozen content and policy. Two mixed-policy cases keep immediate
correct/incorrect visible while buffered partial stays hidden until completion.
Two further cases cover absent effective adjudication and a real activated
terminal unresolved candidate. The absent-head fixture explicitly clears the
mutable effective-head pointer; it verifies the read state, not a retraction
command. The existing real abandoned-to-started reopen test now checks detail
progress/summary reset and absence of the previous occurrence's submission as
well as its existing list/issuance assertions.

### Verification and handoff

All logs are in `/tmp/` with prefix `yuk1047-paper-feedback-`.

| Check | Result | Log suffix |
| --- | --- | --- |
| Verified causal DB RED, before product edits | 8 failed, 33 passed, 3 files | `db-red-verified.log` |
| Same detail API, list API and issuance DB GREEN | 41 passed, 3 files | `db-green.log` |
| Paper cycle, snapshot, provenance, session race, capture and mastery progress DB | 51 passed, 6 files | `db-extended.log` |
| Practice read, paper contracts/sections, frozen study context and evaluation authority unit | 43 passed, 5 files | `unit.log` |
| Typecheck | exit 0 | `typecheck.log` |
| Changed-file Biome | exit 0, 4 existing warnings | `biome.log` |
| Lint ratchet | exit 0, 297 warnings within unchanged 305 baseline | `lint-ratchet.log` |
| Build | exit 0, web/server/worker/migrate built | `build.log` |
| API contracts/client usage, capability boundaries, structured judge | all exit 0 | `audit-{api-contracts,api-client-usage,capability-boundaries,structured-judge}.log` |
| Test partition, schema, task census and provider lanes | all exit 0 | `audit-{partition,schema,task-census,provider-lanes}.log` |

The final total is **92 distinct DB tests and 43 distinct unit tests**. RED and
earlier diagnostic reruns are not added to the final count. Only
`db-red-verified.log` is claimed as the causal RED; earlier diagnostic and fixture
adjustment logs remain available. Every accepted DB run used
`DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock` with disposable
Postgres testcontainers. Capability debt counts remain `437/0/48`.

No route schema, generated client, Postman definition, dependency or migration
changed. PLAN, `.remember` and the pre-existing `.serena/project.yml` modification
were preserved. No full local `pnpm test`, delegation, independent review, push,
PR communication/link/watch, production access or paid provider call ran.
This lane introduces no additional actionable follow-up beyond the two fixed
findings on existing YUK-1047. Parent retains Linear capture/status ownership.
Writer ownership returns to parent after the local repair commit; this lane then
stops. These checks establish local source/DB behavior, not exact-head CI,
deployment or external delivery acceptance.
