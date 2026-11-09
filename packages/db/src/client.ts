import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { DB } from './generated/db';

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;
export type Executor = Database | Tx;

const INT8_OID = 20;
const DATE_OID = 1082;

/**
 * Type parsers scoped to Relay pools (not pg's global registry, so Graphile Worker keeps its
 * own defaults): int8 → number (refusing values beyond 2^53), date → "YYYY-MM-DD" string so a
 * civil date is never shifted by the server's time zone.
 */
const relayTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID) {
      return (value: string) => {
        const n = Number(value);
        if (!Number.isSafeInteger(n))
          throw new RangeError(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
        return n;
      };
    }
    if (oid === DATE_OID) return (value: string) => value;
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName: string;
  onError?: (error: Error) => void;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    types: relayTypes,
  });
  // A client error (idle in the pool, or checked out between queries when the server drops
  // the connection) must not crash the process: it is logged and the client discarded.
  pool.on('error', (error) => options.onError?.(error));
  pool.on('connect', (client) => {
    client.on('error', (error) => options.onError?.(error));
  });
  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

export async function checkDatabase(db: Executor): Promise<{ schemaVersion: string | null }> {
  const row = await sql<{
    value: string;
  }>`SELECT value FROM relay_schema_info WHERE key = 'schema_version'`
    .execute(db)
    .then((r) => r.rows[0]);
  return { schemaVersion: row?.value ?? null };
}

export { sql };
