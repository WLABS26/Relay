import { withMaintenanceScope, withTenant } from '@relay/db';
import { appendAudit, SERVICE_ACTORS } from './audit';
import type { ServiceContext } from './context';
import { safeError } from './logger';
import { enqueue } from './tasks';

/**
 * Periodic reconcilers (worker cron). The scan runs in the worker-only, read-only maintenance
 * scope and returns identifiers; every action happens in a separate tenant transaction that
 * re-reads and re-validates state, so a scan result is only ever a hint.
 */

const STALL_MS = 2 * 60_000;

/** Re-drive destinations whose lease expired or whose due work has no visible progress. */
export async function reconcileDue(ctx: ServiceContext): Promise<{ requeued: number; reconcile: number }> {
  const now = ctx.clock.now();
  const due = await withMaintenanceScope(ctx.db, (tx) =>
    tx
      .selectFrom('postDestinations as pd')
      .innerJoin('publishIntents as i', 'i.id', 'pd.activeIntentId')
      .select(['pd.workspaceId', 'pd.id', 'pd.state', 'pd.leaseExpiresAt', 'pd.leaseOwner', 'i.id as intentId', 'i.intentVersion', 'i.plannedAt'])
      .where('i.status', '=', 'active')
      .where((eb) =>
        eb.or([
          // Expired lease: a worker died mid-step.
          eb.and([eb('pd.leaseOwner', 'is not', null), eb('pd.leaseExpiresAt', '<', new Date(now.getTime() - 30_000))]),
          // Due or in-flight work without progress (lost job, crashed between steps).
          eb.and([
            eb('pd.state', 'in', ['scheduled', 'preparing', 'dispatching', 'processing']),
            eb('pd.leaseOwner', 'is', null),
            eb('i.plannedAt', '<', new Date(now.getTime() - STALL_MS)),
            eb('pd.updatedAt', '<', new Date(now.getTime() - STALL_MS)),
          ]),
          eb.and([eb('pd.state', '=', 'needs_reconciliation'), eb('pd.stateReason', 'is distinct from', 'operator_review_required'), eb('pd.updatedAt', '<', new Date(now.getTime() - STALL_MS))]),
        ]),
      )
      .limit(500)
      .execute(),
  );
  let requeued = 0;
  let reconcile = 0;
  for (const row of due) {
    try {
      await withTenant(ctx.db, { workspaceId: row.workspaceId }, async (tx) => {
        if (row.state === 'needs_reconciliation') {
          await enqueue(tx, 'publish.reconcile', { workspaceId: row.workspaceId, postDestinationId: row.id, intentId: row.intentId }, { jobKey: `reconcile:${row.id}` });
          reconcile++;
        } else {
          // job_key replace: if a job is already pending this just pulls it forward.
          await enqueue(tx, 'publish.advance', { workspaceId: row.workspaceId, postDestinationId: row.id, intentId: row.intentId, intentVersion: row.intentVersion }, { jobKey: `publish:${row.id}` });
          requeued++;
        }
      });
    } catch (error) {
      ctx.logger.warn({ postDestinationId: row.id, err: safeError(error) }, 'reconcileDue: could not requeue');
    }
  }
  if (due.length) ctx.logger.info({ requeued, reconcile }, 'maintenance.reconcile_due');
  return { requeued, reconcile };
}

/** Expire abandoned upload sessions, release their quota and delete partial objects. */
export async function expireUploads(ctx: ServiceContext): Promise<number> {
  const now = ctx.clock.now();
  const expired = await withMaintenanceScope(ctx.db, (tx) =>
    tx
      .selectFrom('uploadSessions')
      .select(['workspaceId', 'id', 'assetId', 'objectKey', 's3UploadId'])
      .where('status', 'in', ['pending', 'completing'])
      .where('expiresAt', '<', now)
      .limit(200)
      .execute(),
  );
  let count = 0;
  for (const s of expired) {
    const changed = await withTenant(ctx.db, { workspaceId: s.workspaceId }, async (tx) => {
      const updated = await tx
        .updateTable('uploadSessions')
        .set({ status: 'expired', endedAt: now, reservationReleasedAt: now, failureCode: 'expired' })
        .where('id', '=', s.id)
        .where('status', 'in', ['pending', 'completing'])
        .returning('id')
        .executeTakeFirst();
      if (!updated) return false;
      await tx.updateTable('mediaAssets').set({ status: 'deleted', deletedAt: now }).where('id', '=', s.assetId).where('status', '=', 'uploading').execute();
      await appendAudit(tx, ctx.ids, { workspaceId: s.workspaceId, actor: SERVICE_ACTORS.maintenance, action: 'upload.expired', entityType: 'media_asset', entityId: s.assetId });
      return true;
    });
    if (!changed) continue;
    if (s.s3UploadId) await ctx.storage.abortMultipart({ key: s.objectKey, uploadId: s.s3UploadId }).catch(() => undefined);
    await ctx.storage.deleteAllVersions(s.objectKey).catch(() => undefined);
    count++;
  }
  return count;
}

/** Remove expired idempotency records (per tenant). */
export async function cleanupExpired(ctx: ServiceContext): Promise<number> {
  const now = ctx.clock.now();
  const workspaces = await withMaintenanceScope(ctx.db, (tx) =>
    tx.selectFrom('idempotencyKeys').select('workspaceId').distinct().where('expiresAt', '<', now).limit(1000).execute(),
  );
  let removed = 0;
  for (const { workspaceId } of workspaces) {
    const result = await withTenant(ctx.db, { workspaceId }, (tx) => tx.deleteFrom('idempotencyKeys').where('expiresAt', '<', now).executeTakeFirst());
    removed += Number(result.numDeletedRows ?? 0);
  }
  return removed;
}
