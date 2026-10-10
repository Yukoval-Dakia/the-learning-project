# YUK-1359 isolated queue runtime: RW_BOSS_AUTOMATION seam

Implementation slice for the root migration restore acceptance (YUK-1359) that
unblocks the "automation absent" property required by the YUK-1346 restored-DB
controlled acceptance. Stage served: 第一天能用 — the restored app must be
runnable on day one against the migrated database without pg-boss arming its
own automation. Runtime acceptance is **UNRUN**; this doc records the code
contract only. Parent owns independent review and the live acceptance.

## Problem closed

With `RW_WORKER=0` the app process never starts a boss at boot, but the first
copilot enqueue lazily calls `getStartedBoss()` → `boss.start()` on a `PgBoss`
constructed with no behavior options. pg-boss 12.36.0 defaults
(`attorney.js` `getConfig`) arm `schedule`, `supervise`, `migrate`,
`createSchema`, and `registerInstance`, so the acceptance action itself
installed the timekeeper (`__pgboss__send-it` row, 5s internal consumer, 30s
cron claim), the supervisor/navigator/bam claim timers, and the registrar
(instance INSERT + 30s heartbeat). The YUK-1346 automation inventory
(`/tmp/yuk1346-isolated-app-automation-inventory.md`, workspace `f21000bc`)
concluded the unchanged image could only claim "no automatic *business* work",
not automation absence; §5 named this exact seam as the minimum product change.

## Contract

One typed env mode: `RW_BOSS_AUTOMATION` = `enabled` | `disabled`, declared as
`z.enum` in `src/server/env.ts` and resolved by `resolveBossAutomationMode()`
(same pattern as `resolveApiPort`). The resolver — not only the zod schema —
rejects any other value, because the `skipValidation` (VITEST) path bypasses
schema validation. Unset, empty, or `enabled` → `enabled`.

`createBoss()` (`src/server/boss/client.ts`) maps the mode to constructor
options:

- `enabled` (default): passes **no** behavior flags. The constructed config is
  identical to the historical `{ connectionString, schema: 'pgboss' }` (plus
  the vitest-only `max: 2` pool cap). No inference from `RW_WORKER`; no
  behavior change in any existing process, worker included.
- `disabled`: passes exactly `schedule: false, supervise: false,
  migrate: false, registerInstance: false`.

## Disabled-mode semantics (verified against installed pg-boss 12.36.0 dist)

`PgBoss.start()` → `#doStart` (index.js:146-185) then behaves as follows:

| Flag | Gate | Effect when false |
| --- | --- | --- |
| `schedule` | `index.js:176` skips `timekeeper.start()` | No `__pgboss__send-it` queue row, no 5s internal SEND_IT consumer, no 30s cron claim pass |
| `supervise` | `boss.js:149` superviseTimer unarmed; `navigator.js:47` early return | No monitor/maintain/deletion claims, no flow-resolution poll |
| `migrate` | `index.js:160` → `contractor.check()` instead of `contractor.start()`; `index.js:179` skips `bam.start()` | Two SELECTs (`isInstalled`, `schemaVersion`); throws if pg-boss not installed or schema ≠ 44. No DDL, no schema creation, no bam claim |
| `registerInstance` | `registrar.js:55` early return | No `pgboss.instance` INSERT, no crash counters, no prune, no 30s heartbeat UPDATE |

Explicit operations still work: `send`, `fetch`, `complete`, `cancel`, `retry`,
`fail`, `createQueue`, `getQueues` all delegate directly to `Manager`
(index.js:301+), independent of the disabled subsystems, against the already
migrated schema (version 44 check enforced by `contractor.check()`).

Singleton, error, and shutdown semantics are unchanged: `bossState` caching,
the 23505 `queue_pkey` swallow on `getStartedBoss`, `startPromise` reset on
real failure, `markBossStarted`, and `stopBossGracefully` are all untouched.

## Runtime limits (honest accounting)

Disabled mode does **not** mean zero reads or zero timers:

- `SELECT version()` startup probe (`#warnIfDistributedMisconfigured`) — read.
- `contractor.check()` two SELECTs at start — read, throws on version mismatch.
- `manager.start()` 60s `queueCacheInterval` SELECT refresh — read.
- `manager.start()` 2s `wipInterval` — in-memory only; emits a `wip` event only
  when locally held work exists, which never happens without `work()`.
- `server/index.ts` 15s config refresh (`startConfigRefresh`) — separate read
  timer owned by config hydration, not by this seam.

All writes that fired under defaults on first enqueue are gone: no instance
row, no `send-it` queue row, no claim-timestamp UPDATEs on
`pgboss.version`/`pgboss.queue` from the disabled owners. Explicit enqueue
writes (job INSERTs) remain — that is the point of the mode.

## Usage boundary

Set `RW_BOSS_AUTOMATION=disabled` only on the isolated acceptance app process.
The worker (`scripts/worker.ts` / `RW_WORKER=1` in-process path) shares
`createBoss()` and must keep the default: a disabled worker's boss would never
arm the timekeeper that fires cron schedules. `RW_BOSS_AUTOMATION` is never
derived from `RW_WORKER`; the two flags are orthogonal.

## Verification performed

- `src/server/boss/client.unit.test.ts` (12 tests, registered in
  `vitest.shared.ts` `fastTestInclude`): constructor option mapping for
  default/explicit-enabled/disabled through the public `createBoss` /
  `getStartedBoss` seams, singleton reuse, invalid-env rejection at both the
  resolver and `createServerEnv` validation, cached-start-promise retry, and
  the 23505 race swallow.
- `pnpm typecheck`, `pnpm lint` (0 errors; 174 pre-existing warnings,
  none in owned files), `pnpm build` (web + server/worker/migrate esbuild
  bundles) — all green in this worktree.
- No DB / testcontainer / runtime / provider work performed; full `pnpm test`
  reserved to exact-head CI Gate. Live runtime acceptance against the restored
  database is UNRUN and owned by the parent.

## Owned files

- `src/server/env.ts` — `RW_BOSS_AUTOMATION` schema entry +
  `resolveBossAutomationMode` / `BossAutomationMode`.
- `src/server/boss/client.ts` — conditional flag mapping in `createBoss()`.
- `src/server/boss/client.unit.test.ts` — new focused unit test.
- `vitest.shared.ts` — suite registration (one line).
- `docs/planning/2026-10-10-yuk1359-isolated-queue-runtime.md` — this doc.

## Parent real SDK verification

Parent added isolated-runtime.db.test.ts and ran it against disposable per-fork PostgreSQL through the canonical getStartedBoss path. All pg-boss table snapshots were identical before/after start and across65seconds with an explicit pending job and scheduled entry. No instance row or asynchronous errors appeared. Explicit send/fetch/complete returned the intended job and persisted completed state. Result1/1, exit0, log /tmp/yuk1359-isolated-queue-db-01/tests.log. Parent typecheck and focused Biome passed. Global teardown returned; shared lock release verified original four runtime containers and release manifest unchanged. No restored target or provider use. This proves the queue-mode boundary with real SDK/DB, not whole-app restored model acceptance.
