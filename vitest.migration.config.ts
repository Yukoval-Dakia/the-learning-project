import { defineConfig } from 'vitest/config';
import { migrationSmokeInclude, resolveConfig, sharedExclude } from './vitest.shared';

export default defineConfig({
  test: {
    include: migrationSmokeInclude,
    exclude: sharedExclude,
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // vitest 4: poolOptions.forks.singleFork → top-level maxWorkers (single fork
    // so the migration-smoke testcontainer is reused). See db config note.
    maxWorkers: 1,
  },
  resolve: resolveConfig,
});
