import { sql, type Tx } from '@relay/db';
import { AppError } from '@relay/domain';
import { fingerprint } from '@relay/domain/server';

/**
 * Idempotency for create/schedule/upload-finalize commands.
 *
 * The key row is inserted inside the business transaction. A concurrent request with the same
 * key blocks on the unique index until the first commits, then sees the stored response; if
 * the first rolls back, its key row disappears with it, so nothing is ever stuck "in
 * progress". Same key + same normalised payload → the original response; same key with a
 * different payload → `idempotency_key_reused`.
 */

export interface IdempotencyRequest {
  workspaceId: string;
  operation: string;
  key: string | null | undefined;
  actorUserId: string | null;
  payload: unknown;
  ttlSeconds?: number;
}

export interface StoredResponse<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

export async function withIdempotency<T>(
  tx: Tx,
  request: IdempotencyRequest,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<StoredResponse<T>> {
  if (!request.key) {
    const result = await fn();
    return { ...result, replayed: false };
  }
  if (!KEY_RE.test(request.key)) {
    throw new AppError('validation_failed', 'Idempotency-Key must be 8–200 characters of [A-Za-z0-9._:-]', {
      fieldErrors: { 'Idempotency-Key': ['Invalid format'] },
    });
  }
  const requestHash = fingerprint({ operation: request.operation, payload: request.payload });
  const ttl = request.ttlSeconds ?? 24 * 3600;
  const inserted = await sql<{ key: string }>`
    INSERT INTO idempotency_keys (workspace_id, operation, key, actor_user_id, request_hash, expires_at)
    VALUES (${request.workspaceId}, ${request.operation}, ${request.key}, ${request.actorUserId}, ${requestHash},
            now() + make_interval(secs => ${ttl}))
    ON CONFLICT (workspace_id, operation, key) DO NOTHING
    RETURNING key`.execute(tx);

  if (inserted.rows.length === 0) {
    const existing = await tx
      .selectFrom('idempotencyKeys')
      .select(['requestHash', 'responseStatus', 'responseBody', 'expiresAt'])
      .where('workspaceId', '=', request.workspaceId)
      .where('operation', '=', request.operation)
      .where('key', '=', request.key)
      .executeTakeFirstOrThrow();
    if (existing.requestHash !== requestHash) {
      throw new AppError('idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
    }
    if (existing.responseStatus === null) {
      throw new AppError('version_conflict', 'A request with this Idempotency-Key is still being processed.', { retryAfterSeconds: 1 });
    }
    return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
  }

  const result = await fn();
  await tx
    .updateTable('idempotencyKeys')
    .set({ responseStatus: result.status, responseBody: JSON.stringify(result.body ?? null) })
    .where('workspaceId', '=', request.workspaceId)
    .where('operation', '=', request.operation)
    .where('key', '=', request.key)
    .execute();
  return { ...result, replayed: false };
}
