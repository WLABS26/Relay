import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseConfig } from '@relay/config';
import { loadDotEnv, REPO_ROOT } from '@relay/config/dotenv';
import { recreateDatabase, withDatabase } from '@relay/db/admin';
import { ObjectStorage } from '@relay/media';
import { generateFixtures } from '@relay/media/fixtures';

/** Recreate the test database from migrations, provision the test bucket, ensure fixtures exist. */
export default async function setup(): Promise<void> {
  loadDotEnv();
  const migrator = process.env.DATABASE_URL_MIGRATOR;
  if (!migrator) throw new Error('DATABASE_URL_MIGRATOR is not set. Copy .env.example to .env and run `pnpm infra:up`.');
  try {
    await recreateDatabase({ migratorUrl: withDatabase(migrator, 'relay_test'), database: 'relay_test', logger: { info: () => {}, warn: console.warn } });
  } catch (error) {
    throw new Error(`Could not prepare the test database (is \`pnpm infra:up\` running?): ${(error as Error).message}`);
  }
  const config = parseConfig({ ...process.env, S3_BUCKET: 'relay-test', RELAY_ENV: 'test' });
  const storage = new ObjectStorage(config.storage);
  await storage.ensureBucket(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3100']);
  const manifest = path.join(REPO_ROOT, 'fixtures/media/manifest.json');
  if (!existsSync(manifest)) await generateFixtures({ outDir: path.dirname(manifest) });
}
