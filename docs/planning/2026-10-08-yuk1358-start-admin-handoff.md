# YUK-1358 Start admin read handoff

## Scope and source result

Sole writer workspace `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`,
branch `feat/yuk-1358-start-admin-reads`. Before writing, the tree was clean at
parent handoff `ea0e3813f769f30fb8233e069ef7b47c76c861fa`; local `origin/main`
was the supplied fresh base `7682618cc47abc57a59c72eb589c360325c59895`.

Five real Start file routes now mount the existing capability pages:
`/admin/runs`, `/admin/cost`, `/admin/failures`, `/admin/coverage-lattice`,
`/admin/conjecture-scores`. All set `ssr: false`, use `StartWorkbenchShell`
and its existing RootShell/TokenGate/document navigation, and inject
`startAdminClient`. Runs includes its independently loaded selected-run detail.
No new shell, visual design, markup or business reader was added.
Production SPA navigation hands these five paths to the Start document, as
Today/Inbox/Mistakes already do. Development and retained legacy consumers keep
an optional client's HTTP default. The injected Start client never falls back
to HTTP after an RPC, schema, token or epoch error.

The six GET server functions use the installed typed Start RPC and existing
request/function auth middleware. Their operation boundary independently calls
Hono `/api/auth/check` through the existing Start auth helper before creating
the reader, importing the public domain module, validating input or acquiring
DB. Runtime query validation runs server-side after that gate; the framework
input validator only transports typed input and grants no authority. The
reader calls only canonical public loaders with caller-owned `Db | Tx`.
Production resolves the existing singleton after auth; tests can inject DB/Tx
and a clock. No query, selector, API handler or recovery mechanism changed.

Canonical parsers preserve runs default 50/max 200/filter/cursor semantics,
cost parseInt/default 30/max 90, and failures default 200/invalid fallback 50/
max 200. Malformed RPC input returns a shaped 400; missing run detail preserves
`404 { error: "not_found", message: "no run <id>" }`. Import/reader failures use
kernel `errorResponse`, which logs server details and returns a fixed generic
500. Token/epoch denials retain the original 401/503 bodies.

RPC returns complete public DTOs directly. Client schemas validate the typed
DTO and then return that original DTO, preserving even nested fields outside
schema projections. There is no JSON roundtrip, unsafe authored cast, Date
adapter, null substitution or narrowed ledger/tool projection. Run, ledger,
tool, timeline, failure and diagnostic timestamps remain ISO strings/null.
The generated route tree retains the framework generator's standard casts;
it was emitted by the installed build, not hand-edited.

## Preserved behavior and known limitation

Runs keeps limit 100, 60-second list polling, independent detail loading/errors,
initial/latest selection, disappearance notice/fallback, and manual refresh of
both list and current detail. Cost keeps 30 days, 60-second polling/manual
refresh and existing currency/truth presentation. Failures keeps limit 200 and
60-second polling/manual refresh. Coverage keeps initial load/manual scan,
loading/disabled scan button, Stateful retry and no polling. Conjectures keeps
initial load/Stateful retry, diagnostics and no invented refresh/polling.
AdminLinks and the original diagnostic-page links/deep links are unchanged.

YUK-1382 remains the existing runs display defect. Replacing its incorrect
nonnullable local types with public DTO types exposes a nullable subtotal
operand. The minimal display-only `run.cost_usd ?? 0` preserves the previous
JavaScript `sum + null` result; existing `formatMoney` also displays null as
zero. This is not a wire adapter or a fix claim. Query/cache/RPC values retain
null, and the DOM parity fixture includes it. Owner-directed UI repair remains
separate. Existing conjecture copy/comments also remain as required by this
nonvisual lane; historical comments do not establish producer runtime state.

## Source verification executed

All commands ran with Node `v24.19.0` through
`PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH`, existing
pnpm/dependencies, in the sole writer workspace. No dependencies were installed.

| Check | Result | Raw log |
| --- | --- | --- |
| Scoped unit command below | 235 tests in 13 files passed, including 73 new admin tests | `/tmp/yuk1358-admin-unit.log` |
| Installed Start client serializer/fixture protocol | 8 tests passed, including all six new admin read DTOs | `/tmp/yuk1358-admin-protocol.log` |
| `pnpm typecheck` | Both TypeScript programs passed; prepared DB suite typechecked | `/tmp/yuk1358-admin-typecheck.log` |
| `pnpm lint` | Passed, 290 warnings | `/tmp/yuk1358-admin-lint.log` |
| `CODEX_FULL_GATE=1 pnpm build` | SPA, Start client/server, app, worker and migrate bundles built; none started | `/tmp/yuk1358-admin-build.log` |
| `pnpm audit:partition` | Passed; unmatched 0, unmocked unit DB imports 0, six existing warnings | `/tmp/yuk1358-admin-partition.log` |
| `pnpm audit:capability-boundaries` | Passed; existing debt ratchets exact | `/tmp/yuk1358-admin-boundaries.log` |
| `git diff --check` | Passed | terminal result |

```sh
pnpm vitest run --config vitest.unit.config.ts \
  server/start/admin-read.unit.test.ts \
  server/start/admin-client.unit.test.ts \
  server/start/auth.unit.test.ts \
  server/start/mistakes-read.unit.test.ts \
  server/start/mistakes-client.unit.test.ts \
  server/start/workbench-read.unit.test.ts \
  server/start/workbench-client.unit.test.ts \
  web/src/routes/AdminPages.start.unit.test.tsx \
  web/src/routes/WorkbenchPages.start.unit.test.tsx \
  src/capabilities/observability/ui/observability-honesty.unit.test.ts \
  src/capabilities/observability/ui/conjecture-scores.unit.test.tsx \
  src/capabilities/observability/server/admin-domain-reads.unit.test.ts \
  src/capabilities/observability/server/diagnostics-domain-reads.unit.test.ts
pnpm exec tsx --test tests/usability/start-rpc-fixtures.unit.spec.ts
```

New tests cover all six operation denials with no reader/DB calls, invalid
limits/status/detail, 404/cursor errors, safe 500s, real canonical parsers,
injected DB/clock arguments, nonempty nested ISO/null/unknown DTOs and mixed
currencies. Client tests cover authority transport/re-gating/epoch/no fallback.
DOM tests compare all five settled pages between default HTTP and injected
clients, and exercise selection, disappearance, separate errors, polling,
manual refresh, disabled scans, retry, diagnostics, no polling and TokenGate
cache clearing. The protocol test uses Start's actual installed serializer and
built resolver map with fixture responses, not a live server or database.

Initial test failures were test assumptions about polling deadlines, existing
generic diagnostic error text and repeated KC labels; corrected without product
behavior changes. One initial typecheck fixture excess-property error and a
DB-test formatting lint error were corrected. Earlier failed logs remain under
`/tmp/yuk1358-admin-{unit-initial,unit-second,typecheck-initial,typecheck-second,lint-error}.log`.

## Prepared DB checks, NOT executed by this writer

Under the parent's existing runtime mutex and disposable synthetic DB boundary:

```sh
cd /Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor
PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH \
  pnpm vitest run --config vitest.db.config.ts \
  server/start/admin-reader.db.test.ts \
  src/capabilities/observability/server/admin-domain-reads.db.test.ts \
  src/capabilities/observability/server/ai-observability.db.test.ts \
  src/capabilities/observability/api/admin-observability.db.test.ts \
  src/capabilities/observability/api/coverage-lattice.db.test.ts \
  src/capabilities/observability/api/conjecture-scores.db.test.ts \
  src/capabilities/observability/api/diagnostic-contracts.db.test.ts
```

The new suite replaces only connection ownership for retained HTTP handlers.
It compares all six authenticated Start adapters with real HTTP/domain/SQL
output from the same injected database, using rich run/unknown ledger/tool,
mixed currencies, active coverage scope and valid/corrupt diagnostic fixtures.
It checks all public-table row-content digests before/after all reads. A second
case reads nonempty uncommitted Tx data, proves an outside connection cannot
see it, checks unauthorized calls do not invoke the operation, verifies the
public snapshots, deliberately rolls back and checks no fixture persists.
Time is fixed only for Date so cost boundaries and coverage scan_ms compare
without replacing SQL or timers. This does not establish sequence/non-public
schema immutability, actual RPC behavior or arbitrary production no-write proof.

## Parent built RPC/browser acceptance recipe

1. Acquire/verify the existing runtime mutex, resolve current release metadata,
   verify the isolated synthetic DB identity and a free loopback acceptance
   port. Use the existing parent-owned `server/start/acceptance-server.ts`
   procedure and production bundles from this revision, with parent-held
   acceptance environment only. Do not run a Vite development server as proof
   of production handoff. The previous workbench handoff documents the existing
   loopback 18952 entry; verify availability before use.
2. Capture built document/chunk/resolver provenance for direct/reloaded visits
   to each of the five paths. Assert no anonymous data in the document and no
   admin read before TokenGate validation. Test missing/wrong/stale token,
   authenticated fenced epoch and re-gating/cache clearing. On real RPC denial,
   capture the original 401/503 bodies and DB deltas; never accept an empty DTO
   as denial. All six RPC IDs resolve from this build's emitted map, not stale
   IDs copied from a previous build.
3. Compare actual `getStartAdminRuns`, `getStartAdminRunDetail`,
   `getStartAdminCost`, `getStartAdminFailures`, `getStartAdminCoverage` and
   `getStartAdminConjectureScores` RPC output with canonical and retained HTTP
   JSON using nonempty/empty/error fixtures. Check run nested ledger/tool/
   timeline timestamps and nullable provenance, cost unknown/known-zero/
   reported/estimated/legacy/mixed currencies, failure sample timestamps,
   coverage activity/null axes and conjecture typed states/dropped/truncated.
   Verify malformed input and detail 404; inject safe reader failure without
   exposing raw DB/provider errors. No provider/worker/replay is needed.
4. In T3 preview, exercise independent list/detail loads/errors, selection,
   disappearance fallback and refresh of both; observe 60-second polling of
   runs/cost/failures and no polling of coverage/conjectures. Exercise coverage
   manual scan/loading disable/retry and conjecture retry. Preserve original
   markup and navigation. Check direct links and document handoff from a
   retained SPA page, plus AdminLinks between migrated and retained paths.
   Network evidence must show these admin reads use `/_serverFn/...`; shared
   shell/other owned consumers can retain their documented HTTP calls.
5. Snapshot all permitted public tables before/after the read-only stage and
   classify any unrelated retained-navigation initialization separately.
   Capture exact source/bundle revision, input/output and log digests. Parent
   owns built usability/browser execution, independent review, PR/CI/tracking,
   integration and any later deployment. Stop only parent-started acceptance
   resources and verify existing services/release unchanged before lock release.

No DB, Docker, server, browser, provider, worker, paid call, replay, deployment,
GitHub/Linear action, PR/watch/push, integration merge or independent review was
performed by this writer. Parent PLAN/.remember and protected config/API/public/
domain/manifest/package/lock/recovery/migration files are unchanged. No new
untracked actionable defect was found; YUK-1382 and remaining migration/exit
work already have owners, so parent should perform tracker capture without a
duplicate issue. Configuration/settings/subjects/writers remain HTTP and outside
this lane. Full route validation is still required before legacy deletion;
this source slice does not retire the old SPA or close all YUK-1358/YUK-1359 work.
Writer releases ownership after the task-owned source/tests/handoff commit.

## Parent integration and first DB acceptance

Main0b925feaa integrated as773066d30; only PLAN/now conflicted. Product admin source is unchanged from2d5ec84ef. Parent independently matched25 source,8 logs and836 initial build hashes. Integrated Node24 checks passed332 unit,8 actual serializer protocol tests,typecheck,lint and full build.

First isolated DB run passed48 existing domain tests and failed both new reader cases during seed: an unknown attempt ledger lacked mandatory cost_ref. The fixture-only1f898bfb4 supplies the existing unpriced provenance reference, preserving null cost. Both new cases then passed in a fresh container, including all-public-table digests,uncommitted Tx isolation,HTTP parity and rollback. No schema/business constraint changed. Original failed logs remain. Parent released both runtime locks after cleanup; the second compared against a new post-OrbStack-restart baseline. The engine shutdown/start observations and exact artifacts are in [parent receipt](evidence/2026-10-08-yuk1358-admin-parent-checks.json).

Independent R1 was cancelled before a verdict and resumed under a distinct task for the same initial review. No completed review or built RPC/browser/deployment acceptance is claimed yet.

Resumed initial review completed with P0/P1 NONE on fixed ea0e3813f..2d5ec84ef; no pending review work. Product files remain identical after main integration and the separate DB fixture repair. PR1615 is draft until built RPC/browser acceptance and exact-head CI complete. Parent retained R2 only if a consequential repair requires it.
