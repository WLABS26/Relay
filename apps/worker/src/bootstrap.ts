import { isConfigError, loadConfig } from '@relay/config';
import { loadDotEnv } from '@relay/config/dotenv';
import { bootstrapDeployment } from '@relay/services/bootstrap';

/**
 * One-off hosted-staging bootstrap: `node dist/bootstrap.js [--no-migrate] [--seed]`.
 * Creates the least-privilege roles when the database has a single login, applies migrations,
 * prepares the bucket (versioning, CORS) and, with --seed, loads the demo data (generating the
 * synthetic media with FFmpeg).
 * The worker also does this on start-up when RELAY_AUTO_MIGRATE / RELAY_AUTO_SEED are set.
 */
loadDotEnv();
const args = new Set(process.argv.slice(2));
try {
  const config = loadConfig();
  const result = await bootstrapDeployment(config, {
    log: (m) => console.log(`[bootstrap] ${m}`),
    migrate: !args.has('--no-migrate'),
    seed: args.has('--seed'),
  });
  console.log(`[bootstrap] done: ${JSON.stringify(result)}`);
} catch (error) {
  if (isConfigError(error)) {
    console.error(error.message);
    process.exit(78);
  }
  console.error(`[bootstrap] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
