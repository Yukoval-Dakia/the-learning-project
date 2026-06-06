import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      '*.test.ts',
      'src/**/*.test.ts',
      'app/**/*.test.ts',
      'workers/src/**/*.test.ts',
      'tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000, // container startup
    pool: 'forks',
    // vitest 4: poolOptions.forks.singleFork → top-level maxWorkers. maxWorkers: 1
    // shares the container across files (legacy single-config; pnpm test:legacy).
    maxWorkers: 1,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
