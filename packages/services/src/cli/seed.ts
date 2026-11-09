import { loadConfig } from '@relay/config';
import { loadDotEnv } from '@relay/config/dotenv';
import { seedDemo } from '../seed';

loadDotEnv();
const started = Date.now();
try {
  const summary = await seedDemo(loadConfig(), { log: (m) => console.log(`[seed] ${m}`) });
  for (const w of summary.workspaces)
    console.log(`[seed] workspace /w/${w.slug}: ${w.pages} pages, ${w.posts} sample posts`);
  console.log(`[seed] demo users (sign in from /sign-in): ${summary.users.join(', ')}`);
  console.log(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (error) {
  console.error(`[seed] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
}
