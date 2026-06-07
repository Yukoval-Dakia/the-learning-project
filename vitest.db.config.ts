import { defineConfig } from 'vitest/config';
import {
  allTestInclude,
  fastTestInclude,
  migrationSmokeInclude,
  resolveConfig,
  sharedExclude,
} from './vitest.shared';

const isListCommand = process.argv[2] === 'list';
if (isListCommand) {
  const dummyUrl = 'postgres://loom:loom@127.0.0.1:5432/loom?sslmode=disable';
  process.env.DATABASE_URL ??= dummyUrl;
  process.env.TEST_DATABASE_URL ??= dummyUrl;
}

export default defineConfig({
  test: {
    include: allTestInclude,
    exclude: [...sharedExclude, ...fastTestInclude, ...migrationSmokeInclude],
    environment: 'node',
    globals: false,
    globalSetup: isListCommand ? [] : ['./tests/global-setup.ts'],
    // YUK-252 — per-fork db wiring. Runs inside each worker BEFORE its test
    // files import, rewriting DATABASE_URL/TEST_DATABASE_URL to this fork's
    // cloned database (test_fork_<VITEST_POOL_ID>). Skipped for `list` since no
    // container/forks exist then. See tests/setup.db-fork.ts (no `@/` imports).
    setupFiles: isListCommand ? [] : ['./tests/setup.db-fork.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // YUK-252 — template-database parallelisation. The single Postgres
    // testcontainer (started once in tests/global-setup.ts) is migrated once,
    // then cloned into test_fork_1..4 via `CREATE DATABASE … TEMPLATE`. Each of
    // the 4 forks connects to its own clone (wired in tests/setup.db-fork.ts),
    // so files run ~4-way parallel without racing on shared rows. Within a
    // single fork, files still share one db and run sequentially, so the
    // existing hermetic contract holds: every db test resets state in
    // beforeEach (resetDb) and must not assume cross-file state.
    //
    // To change parallelism, keep three numbers in lock-step: maxWorkers here,
    // DB_FORK_COUNT in tests/global-setup.ts, and MAX_FORKS in
    // tests/setup.db-fork.ts.
    maxWorkers: 4,
  },
  resolve: resolveConfig,
});
