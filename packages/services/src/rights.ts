import type { Tx } from '@relay/db';
import type { DestinationProviderId } from '@relay/domain';

/**
 * Rights evaluation. A connection or a public URL is never a licence: every asset needs an
 * explicit, unrevoked grant that allows the operation for the destination at the time of
 * use. Called when approving, when scheduling, and again by the worker before dispatch.
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
    provider: DestinationProviderId;
    operation: RightsOperation;
    at: Date;
    commercial?: boolean;
  },
): Promise<RightsDecision> {
  const assetIds = [...new Set(input.assetIds)];
  if (assetIds.length === 0) return { ok: false, grants: [], problems: [], expiresAt: null };
  const rows = await tx
    .selectFrom('sourceRightsGrants')
    .selectAll()
    .where('assetId', 'in', assetIds)
    .orderBy('createdAt', 'asc')
    .execute();
  const decision: RightsDecision = { ok: true, grants: [], problems: [], expiresAt: null };
  for (const assetId of assetIds) {
    const forAsset = rows.filter((r) => r.assetId === assetId);
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
      if (!allowed || (input.commercial && !g.canCommercialUse)) {
        reason = 'operation_denied';
        return false;
      }
      if (g.permittedProviders && !g.permittedProviders.includes(input.provider)) {
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
