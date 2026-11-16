import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfig } from '@relay/config';
import { loadDotEnv, REPO_ROOT } from '@relay/config/dotenv';
import { recreateDatabase, withDatabase } from '@relay/db/admin';
import { ObjectStorage, probeFile } from '@relay/media';
import { FIXTURE_GENERATOR, generateFixtures } from '@relay/media/fixtures';

/** True when the cached fixture set was written by the current generator. */
function fixturesCurrent(manifestPath: string): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { generator?: unknown };
    return manifest.generator === FIXTURE_GENERATOR;
  } catch {
    return false;
  }
}

/** Recreate the test database from migrations, provision the test bucket, ensure fixtures exist. */
export default async function setup(): Promise<void> {
  loadDotEnv();
  const migrator = process.env.DATABASE_URL_MIGRATOR;
  if (!migrator)
    throw new Error(
      'DATABASE_URL_MIGRATOR is not set. Copy .env.example to .env and run `pnpm infra:up`.',
    );
  try {
    await recreateDatabase({
      migratorUrl: withDatabase(migrator, 'relay_test'),
      database: 'relay_test',
      logger: { info: () => {}, warn: console.warn },
    });
  } catch (error) {
    throw new Error(
      `Could not prepare the test database (is \`pnpm infra:up\` running?): ${(error as Error).message}`,
    );
  }
  const config = parseConfig({ ...process.env, S3_BUCKET: 'relay-test', RELAY_ENV: 'test' });
  const storage = new ObjectStorage(config.storage);
  await storage.ensureBucket([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3100',
  ]);
  const manifest = path.join(REPO_ROOT, 'fixtures/media/manifest.json');
  // A set cached by an older generator lacks the newer files, so it is regenerated.
  if (!fixturesCurrent(manifest)) {
    await generateFixtures({ outDir: path.dirname(manifest), ffmpegPath: config.media.ffmpegPath });
  }
  // The trim tests rely on this file having a nonzero container start time; a muxer that
  // normalised the offset away would make them pass without testing anything.
  const offset = await probeFile(
    {
      ffmpegPath: config.media.ffmpegPath,
      ffprobePath: config.media.ffprobePath,
      timeoutSeconds: config.media.timeoutSeconds,
      memoryLimitMb: config.media.memoryLimitMb,
      threads: config.media.threads,
      usePrlimit: config.media.usePrlimit,
    },
    path.join(path.dirname(manifest), 'timecode-offset.mp4'),
    'mov',
  );
  if (!offset.startTimeMs || offset.startTimeMs <= 0) {
    throw new Error('Fixture timecode-offset.mp4 has no container start offset.');
  }
}
