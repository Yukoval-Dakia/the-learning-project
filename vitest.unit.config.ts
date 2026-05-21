import { defineConfig } from 'vitest/config';
import { fastTestInclude, resolveConfig, sharedExclude } from './vitest.shared';

export default defineConfig({
  test: {
    include: fastTestInclude,
    exclude: sharedExclude,
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: resolveConfig,
});
