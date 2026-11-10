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

export type DatabaseRole = 'relay_app' | 'relay_worker';

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName: string;
  onError?: (error: Error) => void;
  /**
   * Single-login mode (hosted staging): the connection string belongs to one login role and
   * every checked-out connection first runs `SET ROLE <role>`, so RLS policies and grants
   * apply exactly as with a dedicated login. A failed SET ROLE destroys the connection and
   * fails the checkout: a query can never run with the login's wider privileges.
   */
  role?: DatabaseRole;
  /** Keep pg's default type parsers (Graphile Worker expects them) instead of Relay's. */
  defaultTypes?: boolean;
}

type ConnectCallback = (
  err: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

class RoleAssumingPool extends pg.Pool {
  constructor(
    config: pg.PoolConfig,
    private readonly role: DatabaseRole,
  ) {
    super(config);
  }

  private async connectAsRole(): Promise<pg.PoolClient> {
    const client = await super.connect();
    try {
      await client.query(`SET ROLE ${pg.escapeIdentifier(this.role)}`);
    } catch (error) {
      client.release(error as Error);
      throw error;
    }
    return client;
  }

  // pg.Pool.query() uses the callback form; Kysely and application code use the promise form.
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const pending = this.connectAsRole();
    if (!callback) return pending;
    pending.then(
      (client) =>
        callback(undefined, client, (release) => client.release(release as Error | undefined)),
      (error: Error) => callback(error, undefined, () => undefined),
    );
  }
}

export function createPool(options: PoolOptions): pg.Pool {
  const config: pg.PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(options.defaultTypes ? {} : { types: relayTypes }),
  };
  const pool = options.role ? new RoleAssumingPool(config, options.role) : new pg.Pool(config);
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
