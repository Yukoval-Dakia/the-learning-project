import { defineConfig } from '@playwright/test';

const baseURL = process.env.USABILITY_BASE_URL ?? 'http://127.0.0.1:18787';

export default defineConfig({
  testDir: './tests/usability',
  testMatch: 'shipped-container.spec.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['line']],
  outputDir: 'test-results/usability',
  globalSetup: './tests/usability/container-preflight.ts',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
