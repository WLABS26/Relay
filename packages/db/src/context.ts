import { sql } from 'kysely';
import { AppError, isUuid } from '@relay/domain';
import type { Database, Tx } from './client';

/**
 * Transaction-scoped database contexts. Row-level security policies read these settings,
 * and set_config(..., true) makes them local to the transaction, so a pooled connection
 * returns to the pool with no tenant context attached.
 *
 * Every tenant-scoped query must run inside `withTenant`. Code outside a tenant transaction
 * sees zero tenant rows (fail closed).
 */

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TenantScope {
  workspaceId: string;
  /** The acting user, if any; workers act without one. */
  userId?: string | null;
}

function assertUuid(value: string, what: string): void {
  if (!isUuid(value)) throw new AppError('not_found', `${what} not found`);
}

export async function withTenant<T>(
  db: Database,
  scope: TenantScope,
  fn: (tx: Tx) => Promise<T>,
  isolation: IsolationLevel = 'read committed',
): Promise<T> {
  assertUuid(scope.workspaceId, 'Workspace');
  if (scope.userId) assertUuid(scope.userId, 'User');
  return db
    .transaction()
    .setIsolationLevel(isolation)
    .execute(async (tx) => {
      await sql`SELECT set_config('relay.workspace_id', ${scope.workspaceId}, true),
                       set_config('relay.user_id', ${scope.userId ?? ''}, true)`.execute(tx);
      return fn(tx);
    });
}

/** User context without a workspace: list own memberships, resolve workspace by slug. */
export async function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(userId, 'User');
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('relay.user_id', ${userId}, true)`.execute(tx);
    return fn(tx);
  });
}

/** Sign-in and session validation, before a user is known. Only the auth module uses this. */
export async function withAuthBootstrap<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('relay.auth_context', 'bootstrap', true)`.execute(tx);
    return fn(tx);
  });
}

/**
 * Worker-only, read-only cross-tenant scan for due work (expired uploads, stale leases, due
 * intents). Policies grant this SELECT-only visibility to the relay_worker role; acting on a
 * found item always happens in a separate `withTenant` transaction.
 */
export async function withMaintenanceScope<T>(
  db: Database,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('relay.scope', 'maintenance', true)`.execute(tx);
    return fn(tx);
  });
}
