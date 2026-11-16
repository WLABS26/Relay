import type { Tx } from '@relay/db';
import { AppError, type DestinationProviderId } from '@relay/domain';
import { z } from 'zod';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';

/**
 * Rights evaluation. A connection or a public URL is never a licence: every asset needs an
 * explicit, unrevoked grant that allows the operation for the destination at the time of
 * use. Called when approving, when scheduling, and again by the worker before dispatch.
 *
 * Rights are inherited by lineage, not copied: a clip rendered from a source is evaluated
 * against the source's grants (and needs its edit right), with problems and grants reported
 * under the clip's own ID. Revoking the source therefore blocks every clip made from it.
 */

export type RightsOperation = 'view' | 'edit' | 'export' | 'publish';

export interface RightsDecision {
  ok: boolean;
  grants: Array<{ assetId: string; grantId: string; grantVersion: number }>;
  problems: Array<{
    assetId: string;
    reason:
      | 'no_grant'
      | 'revoked'
      | 'expired'
      | 'not_yet_valid'
      | 'operation_denied'
      | 'destination_denied';
  }>;
  /** Earliest expiry among chosen grants (scheduling must land before it). */
  expiresAt: Date | null;
}

export async function evaluateRights(
  tx: Tx,
  input: {
    assetIds: string[];
    /** Destination the media is going to. Omit for operations with no destination (edit, view). */
    provider?: DestinationProviderId;
    operation: RightsOperation;
    at: Date;
    commercial?: boolean;
  },
): Promise<RightsDecision> {
  const assetIds = [...new Set(input.assetIds)];
  if (assetIds.length === 0) return { ok: false, grants: [], problems: [], expiresAt: null };
  // A rendered clip holds no grants of its own: its rights are its source's, found through the
  // render job that produced it. The lookup is by output asset, so an asset that merely claims
  // `origin = 'render'` without a job has no lineage and is evaluated (and refused) as itself.
  const lineage = await tx
    .selectFrom('renderJobs')
    .select(['outputAssetId', 'sourceAssetId'])
    .where('outputAssetId', 'in', assetIds)
    .execute();
  const sourceOf = new Map(lineage.map((l) => [l.outputAssetId, l.sourceAssetId]));
  const grantHolders = [...new Set(assetIds.map((id) => sourceOf.get(id) ?? id))];
  const rows = await tx
    .selectFrom('sourceRightsGrants')
    .selectAll()
    .where('assetId', 'in', grantHolders)
    .orderBy('createdAt', 'asc')
    .execute();
  const decision: RightsDecision = { ok: true, grants: [], problems: [], expiresAt: null };
  for (const assetId of assetIds) {
    const derived = sourceOf.has(assetId);
    const holder = sourceOf.get(assetId) ?? assetId;
    const forAsset = rows.filter((r) => r.assetId === holder);
    let reason: RightsDecision['problems'][number]['reason'] = 'no_grant';
    const usable = forAsset.find((g) => {
      if (g.revokedAt) {
        reason = 'revoked';
        return false;
      }
      if (g.validFrom > input.at) {
        reason = 'not_yet_valid';
        return false;
      }
      if (g.validUntil && g.validUntil <= input.at) {
        reason = 'expired';
        return false;
      }
      const allowed =
        input.operation === 'view'
          ? g.canView
          : input.operation === 'edit'
            ? g.canEdit
            : input.operation === 'export'
              ? g.canExport
              : g.canPublish;
      // A clip is an edit of its source, so using it at all needs the right to edit the source.
      if (!allowed || (derived && !g.canEdit) || (input.commercial && !g.canCommercialUse)) {
        reason = 'operation_denied';
        return false;
      }
      if (
        input.provider &&
        g.permittedProviders &&
        !g.permittedProviders.includes(input.provider)
      ) {
        reason = 'destination_denied';
        return false;
      }
      return true;
    });
    if (!usable) {
      decision.ok = false;
      decision.problems.push({ assetId, reason });
      continue;
    }
    decision.grants.push({ assetId, grantId: usable.id, grantVersion: usable.version });
    if (usable.validUntil && (!decision.expiresAt || usable.validUntil < decision.expiresAt))
      decision.expiresAt = usable.validUntil;
  }
  decision.grants.sort((a, b) => a.assetId.localeCompare(b.assetId));
  return decision;
}

export const RIGHTS_PROBLEM_LABELS: Record<RightsDecision['problems'][number]['reason'], string> = {
  no_grant: 'No ownership declaration or licence is recorded for this media.',
  revoked: 'The rights for this media were revoked.',
  expired: 'The rights for this media have expired.',
  not_yet_valid: 'The rights for this media are not valid yet.',
  operation_denied: 'The recorded rights do not allow publishing.',
  destination_denied: 'The recorded rights do not allow this destination.',
};

const revokeRightsGrantSchema = z.strictObject({
  grantId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

/**
 * Withdraw a rights grant. The row is kept (with who, when and why) so past approvals stay
 * explainable; the database bumps the asset's `rights_version`, and that of every clip rendered
 * from it, which makes approvals and intents that captured the old version stale. Revoking a
 * grant that is already revoked changes nothing.
 */
export async function revokeRightsGrant(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta,
): Promise<{ grantId: string; assetId: string; revokedAt: Date; alreadyRevoked: boolean }> {
  const input = revokeRightsGrantSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const grant = await tx
      .selectFrom('sourceRightsGrants as g')
      .innerJoin('mediaAssets as a', 'a.id', 'g.assetId')
      .select(['g.id', 'g.assetId', 'g.revokedAt', 'a.pageId'])
      .where('g.id', '=', input.grantId)
      .forUpdate('g')
      .executeTakeFirst();
    if (!grant) throw new AppError('not_found', 'Rights grant not found');
    // Whoever may declare rights for a page's media may withdraw them.
    authorize(member, 'media.upload', grant.pageId);
    if (grant.revokedAt) {
      return {
        grantId: grant.id,
        assetId: grant.assetId,
        revokedAt: grant.revokedAt,
        alreadyRevoked: true,
      };
    }
    const now = ctx.clock.now();
    await tx
      .updateTable('sourceRightsGrants')
      .set({ revokedAt: now, revokedBy: user.userId, revokeReason: input.reason })
      .where('id', '=', grant.id)
      .where('revokedAt', 'is', null)
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'rights.revoked',
      entityType: 'source_rights_grant',
      entityId: grant.id,
      pageId: grant.pageId,
      data: { assetId: grant.assetId },
      requestId: meta.requestId,
    });
    return { grantId: grant.id, assetId: grant.assetId, revokedAt: now, alreadyRevoked: false };
  });
}
