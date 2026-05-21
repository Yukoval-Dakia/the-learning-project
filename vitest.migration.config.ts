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
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: resolveConfig,
});
