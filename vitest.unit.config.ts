import { defineConfig } from 'vitest/config';
import { fastTestInclude, resolveConfig, sharedExclude, sharedOxc } from './vitest.shared';

export default defineConfig({
  // JSX transform shared with vitest.db.config.ts via sharedOxc (vite 8/Oxc, YUK-315) — tsconfig has
  // `jsx: "preserve"` (Next handles JSX in build), so vitest transforms JSX itself
  // via esbuild's automatic runtime; test files don't need `import React`.
  oxc: sharedOxc,
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
