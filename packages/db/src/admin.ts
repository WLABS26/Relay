import pg from 'pg';
import { migrate, type MigrateLogger } from './migrate';

/**
 * Database administration for local development and tests (never production): create or
 * recreate a database owned by the migrator role with connect rights for app/worker roles,
 * then migrate it. The migrator role has CREATEDB in the local Compose setup only.
 */

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

const SAFE_DB_NAME = /^[a-z][a-z0-9_]{2,62}$/;

export async function recreateDatabase(options: {
  migratorUrl: string;
  database: string;
  logger?: MigrateLogger;
}): Promise<void> {
  if (!SAFE_DB_NAME.test(options.database)) throw new Error(`Refusing unsafe database name "${options.database}"`);
  const admin = new pg.Client({ connectionString: withDatabase(options.migratorUrl, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${options.database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${options.database}`);
    await admin.query(`REVOKE ALL ON DATABASE ${options.database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${options.database} TO relay_app, relay_worker`);
  } finally {
    await admin.end();
  }
  await migrate({ connectionString: withDatabase(options.migratorUrl, options.database), logger: options.logger });
}

export { withDatabase };
