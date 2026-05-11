import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts', 'src/**/*.test.ts', 'workers/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
