import type pg from 'pg';
import { createDatabase, createPool, type Database } from './client';
import { recreateDatabase, withDatabase } from './admin';

/**
 * Integration-test helpers. Tests run against a real PostgreSQL database created from the
 * migrations (never mocked), connecting with the same least-privilege roles as production.
 */

export interface TestDatabaseUrls {
  migrator: string;
  app: string;
  worker: string;
}

export function testDatabaseUrls(database: string, env: Record<string, string | undefined> = process.env): TestDatabaseUrls {
  const migrator = env.DATABASE_URL_MIGRATOR;
  const app = env.DATABASE_URL_APP;
  const worker = env.DATABASE_URL_WORKER;
  if (!migrator || !app || !worker) {
    throw new Error('DATABASE_URL_MIGRATOR, DATABASE_URL_APP and DATABASE_URL_WORKER must be set for integration tests');
  }
  return {
    migrator: withDatabase(migrator, database),
    app: withDatabase(app, database),
    worker: withDatabase(worker, database),
  };
}

export async function prepareTestDatabase(database: string): Promise<TestDatabaseUrls> {
  const urls = testDatabaseUrls(database);
  await recreateDatabase({
    migratorUrl: urls.migrator,
    database,
    logger: { info: () => {}, warn: (m) => console.warn(m) },
  });
  return urls;
}

export interface TestDbHandle {
  pool: pg.Pool;
  db: Database;
  close(): Promise<void>;
}

export function openTestDb(url: string, max = 5): TestDbHandle {
  const pool = createPool({ connectionString: url, max, applicationName: 'relay-test' });
  const db = createDatabase(pool);
  return { pool, db, close: () => db.destroy() };
}
