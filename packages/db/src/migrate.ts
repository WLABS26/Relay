import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Logger, runMigrations } from 'graphile-worker';

/**
 * SQL-first migrations.
 *
 *  - Files in packages/db/migrations named NNNN_description.sql are the source of truth.
 *  - Each runs in its own transaction as the migrator (schema owner) role.
 *  - Applied migrations are recorded with a SHA-256 checksum; editing an applied file, a
 *    database that is ahead of the code, or an out-of-order file all fail the run.
 *  - A session advisory lock prevents concurrent runners.
 *  - Graphile Worker's own schema migrations run next and must land exactly on the revision
 *    pinned below for the pinned graphile-worker version.
 *  - post/*.sql files are idempotent grant scripts re-applied on every run.
 */

import { GRAPHILE_WORKER_SCHEMA_REVISION } from './schema-version';

export { GRAPHILE_WORKER_SCHEMA_REVISION, REQUIRED_SCHEMA_VERSION } from './schema-version';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateLogger {
  info(message: string): void;
  warn(message: string): void;
}

const consoleLogger: MigrateLogger = {
  info: (m) => console.log(`[migrate] ${m}`),
  warn: (m) => console.warn(`[migrate] ${m}`),
};

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const match = FILE_RE.exec(file);
    if (!match) throw new Error(`Migration file "${file}" does not match NNNN_description.sql`);
    const sql = readFileSync(path.join(dir, file), 'utf8');
    migrations.push({
      version: match[1]!,
      name: match[2]!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version numbers');
  return migrations;
}

function loadPostScripts(dir = MIGRATIONS_DIR): Array<{ name: string; sql: string }> {
  const postDir = path.join(dir, 'post');
  return readdirSync(postDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(postDir, name), 'utf8') }));
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
  graphileWorkerRevision: number;
}

export async function migrate(options: {
  connectionString: string;
  logger?: MigrateLogger;
  dir?: string;
}): Promise<MigrateResult> {
  const logger = options.logger ?? consoleLogger;
  const files = loadMigrations(options.dir);
  const client = new pg.Client({ connectionString: options.connectionString, application_name: 'relay-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('relay:schema-migrations'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS relay_schema_migrations (
        version      text PRIMARY KEY,
        name         text NOT NULL,
        checksum     text NOT NULL,
        applied_at   timestamptz NOT NULL DEFAULT now(),
        execution_ms integer NOT NULL
      )`);
    const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM relay_schema_migrations ORDER BY version',
    );
    const byVersion = new Map(files.map((f) => [f.version, f]));
    for (const row of rows) {
      const file = byVersion.get(row.version);
      if (!file) {
        throw new Error(
          `Database has migration ${row.version}_${row.name} which is not in the code base. Refusing to continue (database is ahead of code).`,
        );
      }
      if (file.checksum !== row.checksum) {
        throw new Error(
          `Migration ${row.version}_${row.name} was modified after it was applied (checksum mismatch). Add a new migration instead of editing an applied one.`,
        );
      }
    }
    const appliedVersions = new Set(rows.map((r) => r.version));
    const maxApplied = rows.at(-1)?.version ?? '0000';
    const pending = files.filter((f) => !appliedVersions.has(f.version));
    for (const file of pending) {
      if (file.version < maxApplied) {
        throw new Error(
          `Migration ${file.version}_${file.name} is older than the latest applied migration ${maxApplied}. Renumber it.`,
        );
      }
    }

    for (const file of pending) {
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO relay_schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [file.version, file.name, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.version}_${file.name} failed: ${message}`, { cause: error });
      }
      applied.push(`${file.version}_${file.name}`);
      logger.info(`applied ${file.version}_${file.name} (${Date.now() - started} ms)`);
    }

    // Graphile Worker schema (pinned). Its runner is idempotent and takes its own lock.
    await runMigrations({
      connectionString: options.connectionString,
      logger: new Logger(() => (level, message) => {
        if (level === 'error' || level === 'warning') logger.warn(`graphile-worker: ${message}`);
      }),
    });
    const gw = await client.query<{ id: number }>('SELECT max(id)::int AS id FROM graphile_worker.migrations');
    const revision = gw.rows[0]?.id ?? 0;
    if (revision !== GRAPHILE_WORKER_SCHEMA_REVISION) {
      throw new Error(
        `Graphile Worker schema is at revision ${revision}, expected ${GRAPHILE_WORKER_SCHEMA_REVISION}. Align the pinned graphile-worker version before deploying.`,
      );
    }

    for (const script of loadPostScripts(options.dir)) {
      await client.query(script.sql);
    }

    const latest = files.at(-1)?.version ?? '0000';
    await client.query(
      `INSERT INTO relay_schema_info (key, value) VALUES ('schema_version', $1), ('graphile_worker_revision', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [latest, String(revision)],
    );
    return { applied, alreadyApplied: rows.length, graphileWorkerRevision: revision };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('relay:schema-migrations'))`).catch(() => undefined);
    await client.end();
  }
}

/** Latest migration version known to this build (startup compatibility check). */
export function expectedSchemaVersion(dir = MIGRATIONS_DIR): string {
  return loadMigrations(dir).at(-1)?.version ?? '0000';
}
