import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { parseConfig, type RelayConfig } from '@relay/config';
import { REPO_ROOT } from '@relay/config/dotenv';
import { createPool, sql } from '@relay/db';
import { withDatabase } from '@relay/db/admin';
import { createServiceContext, type ServiceContext } from '@relay/services';
import { bootstrapDeployment, ensureDatabaseRoles } from '@relay/services/bootstrap';

/**
 * Hosted-staging "single-login" mode: one non-superuser login that owns the database (standing
 * in for a provider's owner role such as Neon's) and pools that SET ROLE to relay_app /
 * relay_worker. The dev cluster already holds those roles, so the owner is given exactly what a
 * PostgreSQL 16 CREATEROLE login is left with after creating them itself: ADMIN OPTION without
 * the SET option. The bootstrap must repair that grant and prove the role switch; the pools must
 * then run every connection as the least-privilege role and never as the login.
 */
const DATABASE = 'relay_single';
const OWNER = 'relay_single_owner';
const STRANGER = 'relay_single_stranger';
const PASSWORD = 'relay-single-test';

function loginUrl(user: string, password: string, database: string): string {
  const u = new URL(process.env.DATABASE_URL_MIGRATOR!);
  u.username = user;
  u.password = password;
  return withDatabase(u.toString(), database);
}
const superuserUrl = (database: string) =>
  loginUrl('postgres', process.env.RELAY_PG_SUPERUSER_PASSWORD ?? 'relay-dev-superuser', database);

async function asSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: superuserUrl('postgres') });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

describe('single-login database mode (hosted staging)', () => {
  let config: RelayConfig;
  let app: ServiceContext;
  let worker: ServiceContext;

  beforeAll(async () => {
    await asSuperuser(async (admin) => {
      for (const statement of [
        `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`,
        `DROP ROLE IF EXISTS ${OWNER}`,
        `DROP ROLE IF EXISTS ${STRANGER}`,
        `CREATE ROLE ${OWNER} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
        `CREATE ROLE ${STRANGER} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
        `CREATE DATABASE ${DATABASE} OWNER ${OWNER}`,
        // What PostgreSQL 16 leaves behind when a CREATEROLE login creates a role itself.
        `GRANT relay_app TO ${OWNER} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`,
        `GRANT relay_worker TO ${OWNER} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`,
      ])
        await admin.query(statement);
    });
    const {
      DATABASE_URL_APP: _a,
      DATABASE_URL_WORKER: _w,
      DATABASE_URL_MIGRATOR: _m,
      ...env
    } = process.env;
    config = parseConfig({
      ...env,
      DATABASE_URL: loginUrl(OWNER, PASSWORD, DATABASE),
      S3_BUCKET: 'relay-single',
    });
    expect(config.database.singleLogin).toBe(true);
    const result = await bootstrapDeployment(config, { migrate: true, seed: false });
    expect(result).toMatchObject({
      rolesEnsured: true,
      migrated: true,
      storageReady: true,
      seeded: false,
    });
    app = createServiceContext({ config, role: 'app', poolMax: 2 });
    worker = createServiceContext({ config, role: 'worker', poolMax: 2 });
  });
  afterAll(async () => {
    await app?.db.destroy();
    await worker?.db.destroy();
    await asSuperuser(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${OWNER}`);
      await admin.query(`DROP ROLE IF EXISTS ${STRANGER}`);
    });
  });

  it('gives the owner the SET option on both roles and keeps both roles unable to bypass RLS', async () => {
    const rows = await asSuperuser(async (admin) => {
      const grants = await admin.query<{ role: string; can_set: boolean }>(
        `SELECT r.rolname AS role, bool_or(m.set_option) AS can_set
           FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
          WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)
          GROUP BY 1 ORDER BY 1`,
        [OWNER],
      );
      const roles = await admin.query<{ rolname: string; bypass: boolean }>(
        `SELECT rolname, rolbypassrls AS bypass FROM pg_roles
          WHERE rolname IN ('relay_app', 'relay_worker') ORDER BY 1`,
      );
      return { grants: grants.rows, roles: roles.rows };
    });
    expect(rows.grants).toEqual([
      { role: 'relay_app', can_set: true },
      { role: 'relay_worker', can_set: true },
    ]);
    expect(rows.roles).toEqual([
      { rolname: 'relay_app', bypass: false },
      { rolname: 'relay_worker', bypass: false },
    ]);
  });

  it('runs every connection of each pool as its least-privilege role, not as the login', async () => {
    for (let i = 0; i < 4; i++) {
      const row = await sql<{ me: string; login: string; su: boolean }>`
        SELECT current_user::text AS me, session_user::text AS login,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su
      `.execute(app.db);
      expect(row.rows[0]).toEqual({ me: 'relay_app', login: OWNER, su: false });
    }
    const w = await sql<{ me: string }>`SELECT current_user::text AS me`.execute(worker.db);
    expect(w.rows[0]!.me).toBe('relay_worker');
  });

  it("keeps the role's limits: no DDL, and tenant tables are empty without a tenant context", async () => {
    await expect(sql`CREATE TABLE relay_single_probe (id int)`.execute(app.db)).rejects.toThrow(
      /permission denied/,
    );
    const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM workspaces`.execute(
      app.db,
    );
    expect(rows.rows[0]!.n).toBe(0);
    await expect(sql`INSERT INTO audit_events DEFAULT VALUES`.execute(app.db)).rejects.toThrow();
  });

  it('fails closed when the role cannot be assumed: the checkout is rejected, never downgraded', async () => {
    const pool = createPool({
      connectionString: loginUrl(OWNER, PASSWORD, DATABASE),
      applicationName: 'relay-test-bad-role',
      role: 'relay_nobody' as 'relay_app',
      max: 1,
    });
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/role "relay_nobody" does not exist/);
      await expect(pool.connect()).rejects.toThrow(/relay_nobody/);
    } finally {
      await pool.end();
    }
  });

  it('refuses to bootstrap for a login that may not grant itself the roles', async () => {
    await expect(ensureDatabaseRoles(loginUrl(STRANGER, PASSWORD, DATABASE))).rejects.toThrow(
      /cannot assume relay_app/,
    );
  });

  it('seeds the demo data once and recognises it on the next start, as a restarting worker does', async () => {
    const seed = {
      migrate: false,
      storage: false,
      seed: true,
      fixturesDir: path.join(REPO_ROOT, 'fixtures/media'),
    };
    const first = await bootstrapDeployment(config, seed);
    expect(first).toMatchObject({
      rolesEnsured: true,
      migrated: false,
      storageReady: false,
      seeded: true,
    });
    const second = await bootstrapDeployment(config, seed);
    expect(second.seeded).toBe(false);
    // Still nothing visible without a tenant context.
    const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM workspaces`.execute(
      app.db,
    );
    expect(rows.rows[0]!.n).toBe(0);
  }, 120_000);
});
