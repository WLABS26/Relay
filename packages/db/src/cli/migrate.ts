import { loadDotEnv } from '@relay/config/dotenv';
import { migrate } from '../migrate';

loadDotEnv();
const url = process.env.DATABASE_URL_MIGRATOR;
if (!url) {
  console.error('DATABASE_URL_MIGRATOR is required (see .env.example).');
  process.exit(1);
}
try {
  const result = await migrate({ connectionString: url });
  console.log(
    `[migrate] done: ${result.applied.length} applied, ${result.alreadyApplied} already applied, graphile-worker schema revision ${result.graphileWorkerRevision}`,
  );
} catch (error) {
  console.error(`[migrate] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
