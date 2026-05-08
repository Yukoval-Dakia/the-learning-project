import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'workers/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
