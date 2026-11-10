import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { RelayConfig } from '@relay/config';
import { REQUIRED_SCHEMA_VERSION } from '@relay/db';
import { migrate } from '@relay/db/migrate';
import { ObjectStorage } from '@relay/media';
import { seedDemo } from './seed';

/**
 * Hosted-staging bootstrap: bring a deployment whose database holds a single login (the
 * provider's owner role, e.g. Neon's) and whose bucket was just created to a usable state,
 * without hand-written SQL, console JSON or extra tooling.
 *
 *  1. Ensure the least-privilege roles exist as NOLOGIN roles and that the login may assume
 *     them (single-login mode; see packages/db/src/client.ts).
 *  2. Apply migrations (checksummed, advisory-locked).
 *  3. Prepare the bucket: create it when missing, enable versioning and allow browser uploads
 *     from the public origin (CORS).
 *  4. Seed the demo data once, generating the synthetic media fixtures with FFmpeg.
 *
 * Never used in production: production requires separate roles, operator-run migrations and
 * IaC-managed buckets, and packages/config refuses the automatic flags there.
 */

export const DB_ROLES = ['relay_app', 'relay_worker'] as const;

export type BootstrapLog = (message: string) => void;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ELEVATED_ATTRIBUTES = ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb'] as const;

/**
 * Create the NOLOGIN roles if missing and make sure the current login can SET ROLE to them.
 * PostgreSQL 16 gives the creator of a role ADMIN OPTION on it but, unless createrole_self_grant
 * says otherwise, not the SET option, so plain membership is not enough: the grant is made (or
 * upgraded) explicitly, without INHERIT so the login gains none of the roles' privileges, and
 * then proven with a real SET ROLE. A role that already exists with elevated attributes is
 * refused rather than used as the "least-privilege" role. Serialised across processes, so two
 * replicas starting together do not race on CREATE ROLE.
 */
export async function ensureDatabaseRoles(
  connectionString: string,
  log: BootstrapLog = () => {},
): Promise<void> {
  const client = new pg.Client({ connectionString });
  client.on('error', (error) => log(`role setup connection error: ${error.message}`));
  await client.connect();
  try {
    const version = await client.query<{ v: string }>(
      `SELECT current_setting('server_version_num') AS v`,
    );
    const serverVersion = Number(version.rows[0]?.v);
    if (!(serverVersion >= 160000))
      throw new Error(
        `PostgreSQL 16 or newer is required (role grants with the SET option); found ${version.rows[0]?.v ?? 'unknown'}`,
      );
    const me = await client.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    const superuser = Boolean(me.rows[0]?.rolsuper);
    await client.query(`SELECT pg_advisory_lock(hashtext('relay:roles'))`);
    try {
      for (const role of DB_ROLES) {
        // Role names are a fixed allow-list; still quoted as identifiers.
        const ident = pg.escapeIdentifier(role);
        const existing = await client.query<Record<(typeof ELEVATED_ATTRIBUTES)[number], boolean>>(
          'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1',
          [role],
        );
        const attributes = existing.rows[0];
        if (!attributes) {
          await client
            .query(`CREATE ROLE ${ident} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
            .catch((error: unknown) => {
              // 42710 duplicate_object: created by another process since our check; fine.
              if ((error as { code?: string }).code !== '42710') throw error;
            });
          log(`created role ${role}`);
        } else {
          const elevated = ELEVATED_ATTRIBUTES.filter((a) => attributes[a]);
          if (elevated.length > 0)
            throw new Error(
              `role ${role} already exists with ${elevated.map((a) => a.slice(3).toUpperCase()).join(', ')}, so Relay cannot use it as its least-privilege role. Remove the attributes (ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB) or drop the role and start again.`,
            );
        }
        if (!superuser) {
          const membership = await client.query<{ can_set: boolean | null }>(
            `SELECT bool_or(m.set_option) AS can_set
               FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
              WHERE r.rolname = $1
                AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
            [role],
          );
          if (!membership.rows[0]?.can_set) {
            await client
              .query(`GRANT ${ident} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`)
              .catch((error: unknown) => {
                throw new Error(
                  `the database login cannot assume ${role} (${message(error)}). Run as a role with ADMIN OPTION on ${role}: GRANT ${role} TO <login> WITH SET TRUE, INHERIT FALSE`,
                  { cause: error },
                );
              });
            log(`granted ${role} to the login role`);
          }
        }
        await client.query(`SET ROLE ${ident}`);
        await client.query('RESET ROLE');
      }
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext('relay:roles'))`)
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/** The part of ObjectStorage the storage step uses (injectable for tests). */
export type BucketProvisioner = Pick<ObjectStorage, 'ensureBucket' | 'describeBucket'>;

/**
 * Make the configured bucket usable for this deployment: create it when missing, enable
 * versioning and allow the public origin's browser uploads through CORS. When the access key
 * may not change bucket settings, a bucket that was set up by hand is accepted as long as
 * versioning is on and CORS already allows the origin; anything less fails, never silently,
 * and the error keeps every cause it saw.
 */
export async function ensureStorage(
  config: RelayConfig,
  log: BootstrapLog = () => {},
  storage: BucketProvisioner = new ObjectStorage(config.storage),
): Promise<void> {
  const origin = config.publicOrigin;
  const bucket = config.storage.bucket;
  try {
    await storage.ensureBucket([origin]);
    log(`bucket ${bucket}: versioning on, CORS allows ${origin}`);
    return;
  } catch (error) {
    const reason = message(error);
    let state: Awaited<ReturnType<BucketProvisioner['describeBucket']>> | undefined;
    let inspection: string | undefined;
    try {
      state = await storage.describeBucket();
    } catch (inspectError) {
      inspection = message(inspectError);
    }
    const corsOk = state?.corsOrigins.includes(origin) ?? false;
    if (!state?.versioning || !corsOk) {
      const found = state
        ? ` Found: versioning ${state.versioning ? 'on' : 'off'}, CORS origins [${state.corsOrigins.join(', ')}].`
        : inspection
          ? ` Inspecting it failed as well: ${inspection}.`
          : '';
      throw new Error(
        `bucket "${bucket}" is not ready: ${reason}.${found} Check S3_BUCKET, S3_REGION and the access key. The key needs s3:PutBucketVersioning and s3:PutBucketCORS unless you enable versioning and allow ${origin} in the bucket's CORS rules yourself.`,
        { cause: error },
      );
    }
    log(
      `bucket ${bucket}: settings could not be applied (${reason}); existing versioning and CORS verified`,
    );
  }
}

/** The seed needs the schema this build expects; say so instead of failing on a missing table. */
async function assertSchemaCurrent(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const row = await client
      .query<{ value: string }>(`SELECT value FROM relay_schema_info WHERE key = 'schema_version'`)
      .then((r) => r.rows[0])
      .catch((error: unknown) => {
        // 42P01 undefined_table: never migrated.
        if ((error as { code?: string }).code === '42P01') return undefined;
        throw error;
      });
    if (!row || row.value < REQUIRED_SCHEMA_VERSION)
      throw new Error(
        `database schema is ${row ? `at ${row.value}` : 'missing'} but this build needs ${REQUIRED_SCHEMA_VERSION}: set RELAY_AUTO_MIGRATE=true or run the migrations before seeding`,
      );
  } finally {
    await client.end();
  }
}

export interface BootstrapOptions {
  log?: BootstrapLog;
  /** Where synthetic media lives or is generated (default: a temporary directory). */
  fixturesDir?: string;
  /** Roles (single-login mode) and migrations. Default true. */
  migrate?: boolean;
  /** Bucket creation, versioning and CORS. Defaults to true when migrating or seeding. */
  storage?: boolean;
  /** Demo data (needs RELAY_DEMO_MODE=true); also ensures the roles. Default false. */
  seed?: boolean;
}

export interface BootstrapResult {
  rolesEnsured: boolean;
  migrated: boolean;
  storageReady: boolean;
  seeded: boolean;
}

/**
 * Bring the configured deployment up to date and, if asked, seed it. Safe to run on every
 * start: migrations are idempotent and advisory-locked, bucket provisioning is idempotent, and
 * seeding is skipped (under its own advisory lock) when demo data is already present.
 */
export async function bootstrapDeployment(
  config: RelayConfig,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const log = options.log ?? (() => {});
  if (config.isProduction) throw new Error('bootstrapDeployment is not available in production');
  // Preconditions first, before any side effect.
  if (options.seed && !config.demoMode) throw new Error('Seeding needs RELAY_DEMO_MODE=true');
  const result: BootstrapResult = {
    rolesEnsured: false,
    migrated: false,
    storageReady: false,
    seeded: false,
  };
  const migratorUrl = config.database.migratorUrl;
  if (!migratorUrl)
    throw new Error(
      'DATABASE_URL_MIGRATOR (or DATABASE_URL) is required to bootstrap the deployment',
    );

  const prepare = options.migrate ?? true;
  // Pools cannot assume roles that do not exist yet, so seeding needs them as much as migrating.
  if ((prepare || options.seed) && config.database.singleLogin) {
    await ensureDatabaseRoles(migratorUrl, log);
    result.rolesEnsured = true;
  }
  if (prepare) {
    const outcome = await migrate({
      connectionString: migratorUrl,
      logger: { info: log, warn: log },
    });
    result.migrated = true;
    log(
      `migrations: ${outcome.applied.length} applied, ${outcome.alreadyApplied} already applied (graphile-worker revision ${outcome.graphileWorkerRevision})`,
    );
  } else if (options.seed) {
    await assertSchemaCurrent(migratorUrl);
  }

  if (options.storage ?? (prepare || Boolean(options.seed))) {
    await ensureStorage(config, log);
    result.storageReady = true;
  }

  if (options.seed) {
    // One seeder at a time, across processes.
    const lock = new pg.Client({ connectionString: migratorUrl });
    lock.on('error', (error) => log(`seed lock connection error: ${error.message}`));
    await lock.connect();
    let scratch: string | undefined;
    try {
      await lock.query(`SELECT pg_advisory_lock(hashtext('relay:seed'))`);
      if (!options.fixturesDir) scratch = await mkdtemp(path.join(tmpdir(), 'relay-fixtures-'));
      const summary = await seedDemo(config, { log, fixturesDir: options.fixturesDir ?? scratch });
      result.seeded = summary.workspaces.length > 0;
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('relay:seed'))`).catch(() => undefined);
      await lock.end();
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return result;
}
