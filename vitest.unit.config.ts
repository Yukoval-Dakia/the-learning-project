import { defineConfig } from 'vitest/config';
import { fastTestInclude, resolveConfig, sharedExclude } from './vitest.shared';

export default defineConfig({
  // tsconfig has `jsx: "preserve"` (Next handles JSX in build). Vitest needs to
  // transform JSX itself for component tests — use esbuild's automatic runtime
  // so test files don't need `import React`.
  esbuild: {
    jsx: 'automatic',
  },
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
