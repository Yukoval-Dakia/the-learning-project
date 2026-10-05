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
and agent-control-plane/skill-mirror audits successfully. PR/exact-head CI and
merge window remain pending; YUK-1047 remains open. No deployment or paid calls.
