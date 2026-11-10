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
   * Single-login mode (hosted staging): the connection string belongs to one login role. Each
   * connection asks the server to assume `role` as part of session start (libpq-style startup
   * options, so the switch is part of the server session and not a statement a connection
   * pooler could strand on another backend) and the pool verifies `current_user` before
   * handing the connection out. A connection that is not running as `role` is destroyed and
   * the checkout fails: a query can never run with the login's wider privileges.
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

/**
 * Session settings the dedicated login roles carry through ALTER ROLE (infra/postgres). A role
 * assumed after login does not bring its settings along, so single-login pools set them at
 * session start together with the role.
 */
interface SessionSettings {
  statementTimeout: string;
  idleInTransactionTimeout: string;
}
const APP_SESSION_SETTINGS: SessionSettings = {
  statementTimeout: '15s',
  idleInTransactionTimeout: '30s',
};
const ROLE_SESSION_SETTINGS: Partial<Record<string, SessionSettings>> = {
  relay_app: APP_SESSION_SETTINGS,
  relay_worker: { statementTimeout: '60s', idleInTransactionTimeout: '60s' },
};

/**
 * Startup options (`options` connection parameter) that make the server assume the role. A
 * name outside the allow-list gets the strict settings; the server then rejects the role.
 */
export function roleStartupOptions(role: DatabaseRole): string {
  const s = ROLE_SESSION_SETTINGS[role] ?? APP_SESSION_SETTINGS;
  return `-c role=${role} -c statement_timeout=${s.statementTimeout} -c idle_in_transaction_session_timeout=${s.idleInTransactionTimeout}`;
}

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
      // The role was requested at session start; prove it took effect on this very session.
      const { rows } = await client.query<{ me: string }>('SELECT current_user::text AS me');
      const me = rows[0]?.me;
      if (me !== this.role) {
        throw new Error(
          `database connection runs as "${me ?? 'unknown'}" instead of "${this.role}": the role requested at session start was not applied. This happens behind a connection pooler (transaction pooling) or when the server ignores startup options; use the direct connection string.`,
        );
      }
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
    ...(options.role ? { options: roleStartupOptions(options.role) } : {}),
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
