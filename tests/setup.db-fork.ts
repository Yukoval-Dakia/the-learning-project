// YUK-252 — per-fork database wiring for the db test partition.
//
// Registered as a vitest `setupFiles` entry in vitest.db.config.ts. vitest runs
// each setupFile inside the worker process, *before* the worker's test files
// are imported. That ordering is the whole point: `src/db/client.ts` reads
// `DATABASE_URL` at *import time* and opens a singleton pool, so we must rewrite
// the env to point at this fork's cloned database before any `@/` module loads.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ RED LINE: this file MUST NOT import any `@/` module (or anything that      │
// │ transitively imports `@/db/client`). Doing so would open a Postgres        │
// │ connection against the *un-rewritten* DATABASE_URL (the shared template    │
// │ `test` db), defeating the isolation and re-breaking parallel safety.       │
// │ Keep this file dependency-free: pure env mutation, nothing else.           │
// └──────────────────────────────────────────────────────────────────────────┘
//
// globalSetup (tests/global-setup.ts) already created test_fork_1..N as
// TEMPLATE clones of the migrated container db and exported TEST_DATABASE_URL /
// DATABASE_URL pointing at the *template*. Here we swap the pathname to this
// fork's database. Idempotent: re-running (vitest may re-invoke setupFiles when
// a worker is reused) is a pure reassignment to the same value.

const MAX_FORKS = 4;

const poolIdRaw = process.env.VITEST_POOL_ID;
if (!poolIdRaw) {
  throw new Error(
    'tests/setup.db-fork.ts: VITEST_POOL_ID is not set. This setupFile must run ' +
      "under vitest's forks pool (pool: 'forks' in vitest.db.config.ts). If you " +
      'are running db tests some other way, point DATABASE_URL/TEST_DATABASE_URL ' +
      'at a migrated database yourself and skip this setupFile.',
  );
}

const poolId = Number(poolIdRaw);
if (!Number.isInteger(poolId) || poolId < 1 || poolId > MAX_FORKS) {
  throw new Error(
    `tests/setup.db-fork.ts: VITEST_POOL_ID="${poolIdRaw}" is out of range (expected 1..${MAX_FORKS}). This must match DB_FORK_COUNT in tests/global-setup.ts and maxWorkers in vitest.db.config.ts — they create exactly ${MAX_FORKS} cloned databases. If you raised maxWorkers, raise DB_FORK_COUNT and MAX_FORKS to match.`,
  );
}

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) {
  throw new Error(
    'tests/setup.db-fork.ts: TEST_DATABASE_URL is not set — globalSetup ' +
      '(tests/global-setup.ts) did not run, so no fork databases exist.',
  );
}

const forkUrl = new URL(baseUrl);
forkUrl.pathname = `/test_fork_${poolId}`;
const forkUrlStr = forkUrl.toString();

// Rewrite both env vars so every downstream reader lands on this fork's db:
//  - TEST_DATABASE_URL → tests/helpers/db.ts (testDb lazy pool)
//  - DATABASE_URL      → src/db/client.ts (import-time singleton) + pg-boss
process.env.TEST_DATABASE_URL = forkUrlStr;
process.env.DATABASE_URL = forkUrlStr;
