import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT } from './e2e/env';

/**
 * End-to-end tests against the real stack: production web build (or `next dev` with
 * E2E_DEV=1), the worker with both pools, PostgreSQL and S3-compatible storage — all pointed
 * at the isolated `relay_e2e` database and `relay-e2e` bucket. Providers are simulated.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? undefined },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: 'pnpm exec tsx e2e/stack.ts',
    url: `http://localhost:${E2E_PORT}/api/ready`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
