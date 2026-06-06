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
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // vitest 4 flattened poolOptions.forks.singleFork → top-level maxWorkers.
    // maxWorkers: 1 keeps a single fork so the shared Postgres testcontainer
    // (started once in tests/global-setup.ts) is reused across files instead of
    // each file spinning its own DB. (vitest 4 migration: pool config.)
    maxWorkers: 1,
  },
  resolve: resolveConfig,
});
