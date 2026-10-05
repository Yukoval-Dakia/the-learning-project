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

## Failing checks and parent-owned gaps

1. `submit-durable-resource.db.test.ts` still fails
   “releases a diagnostic claim when durable admission returns an error response”:
   expected question `draft_status=active`, received `draft`. The broader 10-file
   run had 150/152 pass before the new historical-event fixture was corrected;
   the corrected placement suite is now green as shown above. Its other failure
   was this unchanged diagnostic assertion.
   Log: `/tmp/yuk1047-placement-db-final.log`.
   Attribution check restored **only** `submit.ts` from starting HEAD `04f0bcaf7`,
   ran the single diagnostic test and restored the current file in `finally`.
   The same failure reproduced (1 failed, 2 skipped, exit 1):
   `/tmp/yuk1047-placement-diagnostic-baseline.log`.
   Exact baseline test command:
   `DOCKER_HOST=unix:///Users/yuqi/.orbstack/run/docker.sock pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/api/submit-durable-resource.db.test.ts -t 'releases a diagnostic claim'`.
   Source shows dispatch captures the original before durable admission; claim
   release requires no assessment submission. This explains the retained draft,
   but parent must decide the correct diagnostic recovery contract.
   No diagnostic expectation was weakened and no unrelated repair was made.
2. `pnpm lint:ratchet` exits 1: baseline 305 warnings versus current 328.
   Log: `/tmp/yuk1047-placement-lint-ratchet.log`.
   Full JSON: `/tmp/yuk1047-placement-biome.json`. The three diagnostics touching
   task-owned files are two existing lines in submit.ts and the existing
   AttachmentStrip group role, all present at starting HEAD. The broader migration
   debt includes 25 non-null assertion warnings. No lint/audit baseline was raised.
   Parent must disposition this before exact-head CI; ordinary lint passes.
3. Parent still needs real API/browser placement acceptance, its sole independent
   repair review, Linear capture/status, PR and exact-head CI. This lane did not
   initiate a review or perform push/PR/merge/deployment. YUK-1047 remains open.

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
