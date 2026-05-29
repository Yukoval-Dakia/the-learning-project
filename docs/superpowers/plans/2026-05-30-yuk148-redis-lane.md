# YUK-148 — Cross-process editing presence via Redis (lane plan)

**Branch:** `yuk-148-redis-editing-presence` (off main `ee2ce693`)
**Date:** 2026-05-30
**Issue:** [YUK-148](https://linear.app/yukoval-studios/issue/YUK-148)

## Problem

`src/server/artifacts/editing-session.ts` holds editing presence in a process-local
`const sessions = new Map(...)`. The Next web server and the pg-boss worker
(`scripts/worker.ts`) are **separate processes**. While the user is actively editing
a note, the web process records heartbeats via `/api/editing-session/heartbeat`, but
the worker's note-refine handler calls `isArtifactIdle()` against its **own empty
Map**, sees "idle", and applies an AI patch mid-edit. Presence must be shared across
processes. (Locked decision: Redis-backed presence.)

## Design

1. **`PresenceStore` interface** capturing the current behaviors exactly:
   - `recordEditingHeartbeat` (stamp `editingStartedAt` only on first editing heartbeat,
     clear on idle)
   - `isArtifactIdle` (sticky idle-on-heartbeat-timeout transition — MUTATES on timeout)
   - `enqueueOrApplyNoteRefinePatch` (force-apply ceiling + defer-vs-apply decision)
   - `markArtifactIdleAndFlush` (drain pending in FIFO order)
   - `getEditingSessionSnapshot`
   - `reset` (test helper)
2. **Two impls**:
   - **In-memory** (default; today's Map behavior) — used by dev + the fast unit suite.
   - **Redis** (`ioredis`) — selected when `REDIS_URL` is set. Whole per-artifact state
     is ONE Redis key holding serialized JSON `{ status, lastHeartbeatAt,
     editingStartedAt, pending[] }`. Each compound op is a single Lua script
     (`defineCommand`) → atomic by Redis single-threaded execution, no WATCH/MULTI retry
     loop. TTL aligned to heartbeat timeout so stale presence self-expires; a
     missing/expired key reads as idle (safe default).
   - **Factory** `getPresenceStore()` picks impl by `REDIS_URL` presence (lazy singleton).
3. **Atomicity:** the persist-to-DB side effect (`persistNoteRefineApply`) cannot run
   inside Lua. So the Redis impl uses Lua to make the **decision** (apply vs defer; which
   patches to drain) atomically against the shared key, then performs the DB write
   outside the script. enqueue Lua either (a) appends to pending and returns "deferred",
   or (b) returns "apply" without mutating pending. flush Lua atomically reads+clears
   pending and sets idle, returning the drained list to apply.
4. **Async signatures:** `recordEditingHeartbeat`, `isArtifactIdle`,
   `getEditingSessionSnapshot` become `async` (Redis I/O). Ripple `await` to consumers.
5. **docker-compose:** add `redis:7-alpine` on `internal` net with healthcheck; inject
   `REDIS_URL=redis://redis:6379` into `app` + `worker`. Ephemeral — no volume/AOF.
6. **Connection mgmt:** single shared lazy `ioredis` client module; graceful when
   `REDIS_URL` unset. Close on worker shutdown.

## Consumers (verified via grep)

- `app/api/editing-session/heartbeat/route.ts` — `recordEditingHeartbeat` (currently NOT
  awaited → add `await`).
- `app/api/editing-session/blur/route.ts` — `markArtifactIdleAndFlush` (already awaited).
- `src/server/boss/handlers/note-refine.ts:229` — `enqueueOrApplyNoteRefinePatch` (already
  awaited).
- `src/server/boss/handlers/note-refine.test.ts` — DB test; uses `recordEditingHeartbeat`
  (sync call at L340 → add `await`), `markArtifactIdleAndFlush`, `resetEditingSessionStateForTests`.
- UI `src/ui/block-tree/ArtifactBlockTree.tsx` — calls the ROUTES via fetch, not the fns;
  no change (confirmed by grep: no direct import).

`hub_auto_sync_nightly.ts` / `handlers.ts` — grep shows NO editing-session usage; nothing
to ripple there.

## Files

### Create
- `src/server/redis/client.ts` — lazy shared `ioredis` singleton + `closeRedis()`.
- `src/server/artifacts/presence/types.ts` — `PresenceStore` interface + shared types
  (`EditingStatus`, `QueuedPatch`, snapshot, constants).
- `src/server/artifacts/presence/in-memory.ts` — Map-backed impl (today's behavior).
- `src/server/artifacts/presence/redis.ts` — ioredis + Lua impl.
- `src/server/artifacts/presence/redis.integration.test.ts` — cross-instance regression
  (db partition; self-contained Redis testcontainer).
- `docs/adr/ADR-0023-cross-process-editing-presence-via-redis.md`

### Modify
- `src/server/artifacts/editing-session.ts` — becomes a thin façade: factory selection +
  async exported fns delegating to the active `PresenceStore`. Keeps the existing public
  API (names + `EDITING_*` constants) so consumers and tests barely change.
- `app/api/editing-session/heartbeat/route.ts` — `await recordEditingHeartbeat(...)`.
- `src/server/boss/handlers/note-refine.test.ts` — `await recordEditingHeartbeat(...)` at L340.
- `src/server/artifacts/editing-session.test.ts` — add `await` to now-async calls; stays
  in-memory / fast unit; all 11 cases unchanged semantics.
- `scripts/worker.ts` — close Redis on shutdown (wire into shutdown handler).
- `src/server/boss/shutdown.ts` — also close Redis client on graceful stop.
- `docker-compose.yml` — add `redis` service + `REDIS_URL` env for app/worker.
- `.env.example` — document `REDIS_URL`.
- `package.json` — add `ioredis` (dep) + `@testcontainers/redis` (devDep).

## Build order

1. `pnpm add ioredis` + `pnpm add -D @testcontainers/redis`.
2. `src/server/redis/client.ts` (shared client).
3. `presence/types.ts` (interface + types).
4. `presence/in-memory.ts` (extract today's Map logic, unchanged semantics).
5. `presence/redis.ts` (Lua impl).
6. Rewrite `editing-session.ts` as façade + factory.
7. Ripple `await` to heartbeat route + note-refine.test + editing-session.test.
8. docker-compose + .env.example + worker/shutdown wiring.
9. `presence/redis.integration.test.ts` (cross-instance regression).
10. ADR-0023.
11. Gate: typecheck / lint / audit:schema / audit:partition / audit:profile / test / build.

## Risks / notes

- The fast unit suite MUST NOT gain a `testcontainers`/`ioredis` taint via the test file's
  direct imports. `editing-session.test.ts` imports only the façade — façade imports
  `ioredis` transitively but the partition audit is file-level on the TEST file, so it stays
  clean. The Redis integration test imports `testcontainers` directly → correctly lands in
  the db partition.
- `persistNoteRefineApply` is a DB side effect that cannot run inside Lua; Lua makes only
  the decision atomically, the DB write happens after. Documented in ADR.
