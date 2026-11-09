import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '@relay/config/dotenv';
import { recreateDatabase, withDatabase } from '../admin';

/**
 * Generate (or with --check, verify) Kysely types from a freshly migrated scratch database.
 * This is the "checked migrations" gate: CI fails if the committed types do not match what
 * the SQL migrations actually produce.
 */
loadDotEnv();
const url = process.env.DATABASE_URL_MIGRATOR;
if (!url) {
  console.error('DATABASE_URL_MIGRATOR is required.');
  process.exit(1);
}
const check = process.argv.includes('--check');
const database = 'relay_codegen';
await recreateDatabase({
  migratorUrl: url,
  database,
  logger: { info: () => {}, warn: console.warn },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, '../generated/db.ts');
const args = [
  'kysely-codegen',
  '--dialect',
  'postgres',
  '--url',
  withDatabase(url, database),
  '--camel-case',
  '--date-parser',
  'string',
  '--numeric-parser',
  'string',
  '--type-mapping',
  JSON.stringify({ int8: 'number' }),
  '--include-pattern',
  '{public,provider_sim}.*',
  '--exclude-pattern',
  'public.relay_schema_migrations',
  '--default-schema',
  'public',
  '--out-file',
  outFile,
  '--log-level',
  'warn',
];
if (check) args.push('--verify');
try {
  execFileSync('npx', args, { stdio: 'inherit', cwd: path.resolve(here, '../..') });
  console.log(check ? '[types] generated types are up to date' : `[types] wrote ${outFile}`);
} catch {
  console.error(
    check
      ? '[types] generated types are OUT OF DATE — run `pnpm db:types`'
      : '[types] generation failed',
  );
  process.exit(1);
}
