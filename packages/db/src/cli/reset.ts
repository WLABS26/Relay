import { loadDotEnv } from '@relay/config/dotenv';
import { databaseNameOf, recreateDatabase } from '../admin';

/** Drop and recreate the local database from migrations (development only). */
loadDotEnv();
const url = process.env.DATABASE_URL_MIGRATOR;
const env = process.env.RELAY_ENV ?? (process.env.NODE_ENV === 'production' ? 'production' : 'local');
if (!url) {
  console.error('DATABASE_URL_MIGRATOR is required.');
  process.exit(1);
}
if (env !== 'local' && env !== 'test') {
  console.error(`Refusing to reset a database when RELAY_ENV=${env}.`);
  process.exit(1);
}
const database = databaseNameOf(url);
await recreateDatabase({ migratorUrl: url, database });
console.log(`[reset] recreated and migrated database "${database}"`);
