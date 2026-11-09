import { loadDotEnv } from '@relay/config/dotenv';
import { withDatabase } from '@relay/db/admin';

/**
 * Point every integration test at the throwaway `relay_test` database and `relay-test`
 * bucket, never at the developer's `relay` database.
 */
loadDotEnv();

export const TEST_DATABASE = 'relay_test';
export const TEST_BUCKET = 'relay-test';

for (const key of ['DATABASE_URL_MIGRATOR', 'DATABASE_URL_APP', 'DATABASE_URL_WORKER'] as const) {
  const url = process.env[key];
  if (url) process.env[key] = withDatabase(url, TEST_DATABASE);
}
process.env.S3_BUCKET = TEST_BUCKET;
process.env.RELAY_ENV = 'test';
process.env.RELAY_DEMO_MODE = 'true';
process.env.RELAY_LOG_LEVEL = process.env.RELAY_LOG_LEVEL_TEST ?? 'silent';
