# YUK-1378 Today cost read

## Scope and public contract

This bounded YUK-1358 child extracts today's existing cost read for the main owner's Start integration. Workspace: `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`. Branch: `feat/yuk-1378-today-cost-read`. Base main: `caeb959fd726e34b2e8554bd0e95b54778cbff41`, with the parent's documentation commit `db191745af967b6169a1ee81b56f6d1e35f0212b`. Implementation used one delegated writer; the parent owns acceptance and delivery.

Public entry: `src/capabilities/observability/public.ts` exports `loadTodayCost` and `TodayCost`. Implementation: `src/capabilities/observability/server/today-cost.ts`.

```ts
loadTodayCost(db: Db | Tx, now: Date = new Date()): Promise<TodayCost>
type TodayCost = z.infer<typeof CostTodayResponseSchema>
```

The existing schema in `api/admin-observability-contracts.ts` remains the read-only DTO authority. The domain creates no Request or Response and imports `Db`/`Tx` as types only. GET `/api/cost/today` invokes the loader through `public.ts`, injects the existing HTTP database, serializes the result and retains `errorResponse` handling. The obsolete Next.js comment is removed.

One `now` sample determines both BJT midnight and `window.to`. All cost projection, provider-authority/deduplication and aggregation remain in the unchanged `provider-cost-projection.ts`. The loader calls `readProviderCostAggregates(db, from)` and preserves the existing lower-bound-only tool-call query. `window.to` is descriptive, not a new query cutoff. Future rows remain included if they meet the lower bound.

The original mapping and wire keys are preserved, including per-currency known subtotals, reported/estimated counts, explicit unknown attempts, legacy rows, truth references, task calls, tokens and tool calls. Unknown truth rows retain their existing numeric known subtotal plus explicit unknown count; they are not classified as known-zero reported observations. No cross-currency money total is exposed.

## Prepared tests

- `server/today-cost.unit.test.ts`: eight cases cover before/at/after BJT midnight, injected database forwarding, a default-clock read crossing midnight, the actual HTTP/public consumer, raw projection/tool-query rejection, safe HTTP 500 and preserved ApiError headers/status.
- `server/today-cost.db.test.ts`: five prepared cases use existing `testDb`, `beginTestTransaction` and rollback helpers. A nested real Tx has nonzero uncommitted USD/CNY reported, estimated, unknown, known-zero and legacy fixtures, provider-linked duplicate exclusion, task/token/call counts and tool rows. Separate singleton-domain and HTTP reads cannot see those fixtures. Boundary cases retain future cost/tool rows. An injected Db empty case checks the complete DTO; rollback leaves no fixture cost.
- `api/admin-observability.db.test.ts`: the existing populated HTTP contract fixture now asserts exact public-domain DTO parity using its sampled HTTP timestamp. Its existing projection/zero-cost/unknown/legacy tests remain available unchanged.

Parent-owned command, prepared but **not run** by this lane:

```bash
pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/server/today-cost.db.test.ts src/capabilities/observability/api/admin-observability.db.test.ts
```

The parent must acquire its deployment lock and apply its usual isolated DB checks before running this command. No DB, testcontainer, service, provider, payment, queue, replay or runtime operation occurred here.

## Local validation

Commands ran with Node `v26.10.0` and pnpm `11.13.1`; production esbuild targets remain Node 24. Logs are local artifacts in `/tmp`.

| Command | Exit/result | Log |
| --- | --- | --- |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/today-cost.unit.test.ts` | 0; 8 tests passed | `/tmp/yuk1378-unit.log` |
| `pnpm typecheck` | 0; app and Start TypeScript checks | `/tmp/yuk1378-typecheck.log` |
| `pnpm typecheck`, after the final DB parity assertion | 0; app and Start TypeScript checks | `/tmp/yuk1378-final-typecheck.log` |
| `pnpm lint` | 0; 297 existing warnings | `/tmp/yuk1378-lint.log` |
| `pnpm build` | 0; SPA, Start, server, worker and migrate bundles | `/tmp/yuk1378-build.log` |
| `pnpm gen:postman` | 0; 33 folders, 87 paths, 94 requests; output unchanged | `/tmp/yuk1378-postman.log` |
| `pnpm exec biome check` with all six owned TypeScript files | 0; no diagnostics or fixes | `/tmp/yuk1378-owned-biome.log` |
| Source mapping and parent-file comparison | 0; original mapping preserved; all five parent docs unchanged | `/tmp/yuk1378-source-contract.log` |

Postman specifications need no contract change. SHA-256 comparison confirms both specification and generated collection are unchanged, so no file outside ownership was committed. The projection and DTO schema also match their pre-edit hashes. No full local test suite ran. Source/unit/build success does not establish DB behavior, independent review, exact-head CI, Start authentication/epoch integration, browser behavior or runtime acceptance.

## Source hashes and handoff

SHA-256 for the six owned TypeScript files:

| File relative to `src/capabilities/observability/` | SHA-256 |
| --- | --- |
| `api/cost-today.ts` | `ad7c376476a71a6f14774ce05bbd17103615a3287af9eef9e934128d1f697114` |
| `api/admin-observability.db.test.ts` | `79e46cbaad6654dad25c97965cc522fd38e1b3d373f5644e2451c8178501c3f0` |
| `public.ts` | `16c2bd9a726fd129302c9cb37927d1f2ca2a5bda090819066570fece1c22b345` |
| `server/today-cost.ts` | `0e9fb4849787921d48490d54f128a6e15bf5172adab4c8fcf016c6fee8a2b9f3` |
| `server/today-cost.unit.test.ts` | `150d0bb21f3d4a5d6ec5f57ad8fe6e88c8f915289252f3701b444562fdf36413` |
| `server/today-cost.db.test.ts` | `656c3d3de62c7fe7b17daa4c7173c58209006f20e977bd2bad60532707dca656` |

The final handoff reports the commit and this document's hash separately. Parent owns DB execution, independent review, Start/compose integration, issue state, push, PR, CI and any deployment. No Start/UI/manifest/package/lock/practice/copilot/YUK-1356 files or parent documentation were modified. No new actionable follow-up was found beyond the assigned YUK-1378 validation and existing YUK-1358 integration obligations; Linear and global board edits are explicitly excluded from this lane. Sole writer ownership is released after the terminal local commit.

## Parent database acceptance

Parent verified all six source/test SHA-256 values and the handoff document on exact implementation `603c9674e79f12811ebcb77852d138accd25b4eb`. The writer completed with no pending runs and a clean tree. Parent then ran the two-file DB command above under the deployment mutex: **11 tests passed in 2 files, exit 0**. This covers the five new injected-DB cases and six existing observability contract cases, including populated public/HTTP parity. Log: `/tmp/yuk1378-parent-db.log`.

The lock was atomically acquired at 2026-10-08 10:32:57Z and owner-checked/released at 10:34:07Z. The temporary test Postgres exited. Original four running container IDs, images, start times and healthy states were unchanged; the release-file digest was unchanged. Evidence: `/tmp/yuk1378-db-before.json` and `/tmp/yuk1378-db-cleanup.json`. The main and runtime owners were notified. No retained database, deployment, provider call, worker replay or queue change occurred.

Independent R1 review of 603c9674e against caeb959fd completed with no P0/P1 findings. The first exact-head CI found a test-partition violation described below; corrected-head CI remains required. Start integration and whole-page acceptance remain with 1358; this source delivery does not complete the migration.

## CI test-partition correction

CI run `37764472650` rejected `today-cost.unit.test.ts` because it directly imported unmocked Drizzle SQL compilation and schema modules. The parent removed that duplicate SQL-string assertion from the unit file. The unchanged DB suite already verifies actual cost and tool-call rows immediately before, at and after BJT midnight, including future-row behavior. The test-partition policy and allowlist were not changed.

The corrected unit suite passes all eight tests and `pnpm audit:partition` reports no P0 errors. Logs: `/tmp/yuk1378-partition-fix-unit.log` and `/tmp/yuk1378-partition-fix-audit.log`. Production TypeScript and both accepted DB suites are unchanged, so the 11-test database evidence still applies. The earlier source-hash table describes implementation603c9674e; the corrected unit-file SHA-256 is `1e425e68548f734cf8989a9d8bdcaf4db83bd3baec5977b864e45d971a0c6ed5`. Typecheck, lint and build all exited 0 after the correction; independent exit codes are recorded in `/tmp/yuk1378-partition-fix-checks.json`. A sole verification review checks this test change; corrected-head CI is still required.

## Delivery

PR [1604](https://github.com/Yukoval-Dakia/the-learning-project/pull/1604) merged at 2026-10-08 10:55:10Z as `6150f01a949c3d1357f8b44f0d8ed6807cd74179`. The merge tree and exact CI head `463aadec322acaad2c96c1e02402a8b6ffd4029e` both resolve to `c9e440e5edd1dd62e7cd4f5cdd018e4d9ee93886`. CI Gate run `37765137606` passed every job. The sole verification review returned no P0/P1 findings; review threads were empty. Codex quota exhaustion and CodeRabbit skipped review were not counted as independent reviews.

YUK1378 is Done for this bounded shared-read slice. The main integration owner received the merge SHA and public `loadTodayCost(db: Db | Tx, now?: Date): Promise<TodayCost>` contract. YUK1358, YUK1359 and YUK1377 remain In Progress for their remaining scope. No deployment occurred. Remaining Start consumption and whole-page acceptance already belong to those issues; no duplicate follow-up was created.
