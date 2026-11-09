import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *   unit         pure logic, no I/O (`pnpm test`)
 *   integration  real PostgreSQL + S3-compatible storage + FFmpeg (`pnpm test:integration`);
 *                globalSetup recreates the `relay_test` database from migrations and provisions
 *                the `relay-test` bucket. Requires `pnpm infra:up`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          setupFiles: ['tests/integration/env.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Files run in parallel; every test creates its own tenants, so they never share rows.
          maxWorkers: 4,
        },
      },
    ],
  },
});
