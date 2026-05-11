import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts', 'src/**/*.test.ts', 'workers/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000, // container startup
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // share container across files
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
