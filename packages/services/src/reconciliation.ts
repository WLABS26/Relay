import { AppError, reconcileSchema } from '@relay/domain';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser } from './access';
import { appendAudit } from './audit';
import { toConnectedAccount } from './connections';
import type { RequestMeta, ServiceContext } from './context';
import { destinationRefs, lockForScheduling, transitionDestination } from './destinations';
import { recordPublication } from './publishing';

/**
 * Operator resolution of an unknown publish outcome. Relay never guesses: an owner or admin
 * either links the external post ID they verified on the platform, or closes the incident as
 * "not published" with a recorded reason (after which a retry may resend).
 */
export async function resolveReconciliation(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postDestinationId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = reconcileSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const refs = await destinationRefs(tx, postDestinationId);
    if (!refs) throw new AppError('not_found', 'Destination not found');
    authorize(member, 'content.reconcile', refs.pageId);
    const { account, destination } = await lockForScheduling(tx, {
      socialAccountId: refs.socialAccountId,
      pageId: refs.pageId,
      postDestinationId,
    });
    if (destination.version !== input.expectedVersion)
      throw new AppError('version_conflict', 'This destination changed since you loaded it.');
    if (destination.state !== 'needs_reconciliation')
      throw new AppError(
        'invalid_transition',
        'Only destinations with an unknown outcome can be reconciled.',
      );
    const intent = destination.activeIntentId
      ? await tx
          .selectFrom('publishIntents')
          .selectAll()
          .where('id', '=', destination.activeIntentId)
          .executeTakeFirst()
      : null;
    if (!intent)
      throw new AppError('invalid_transition', 'This destination has no active publish intent.');
    const now = ctx.clock.now();
    if (input.action === 'link_external') {
      const duplicate = await tx
        .selectFrom('externalPublications')
        .select('id')
        .where('socialAccountId', '=', account.id)
        .where('externalId', '=', input.externalId)
        .executeTakeFirst();
      if (duplicate)
        throw new AppError(
          'validation_failed',
          'That external post is already linked to another Relay post.',
          { fieldErrors: { externalId: ['Already linked'] } },
        );
      const media = await tx
        .selectFrom('postRevisionMedia as rm')
        .innerJoin('mediaAssets as a', 'a.id', 'rm.assetId')
        .select(['a.kind'])
        .where('rm.revisionId', '=', intent.revisionId)
        .execute();
      const variant = await tx
        .selectFrom('postRevisionVariants')
        .select(['visibility'])
        .where('revisionId', '=', intent.revisionId)
        .where('postDestinationId', '=', postDestinationId)
        .executeTakeFirstOrThrow();
      const grant = await tx
        .selectFrom('providerGrants')
        .select(['grantedScopes'])
        .where('id', '=', account.grantId)
        .executeTakeFirstOrThrow();
      const publicationId = await recordPublication(tx, ctx, {
        workspaceId,
        postDestinationId,
        intentId: intent.id,
        state: 'needs_reconciliation',
        account: toConnectedAccount(account, grant.grantedScopes),
        externalId: input.externalId,
        containerId: null,
        permalink: input.permalink ?? null,
        visibility: variant.visibility,
        publishedAt: now,
        plannedAt: intent.plannedAt,
        format:
          media.length > 1
            ? 'carousel'
            : ((media[0]?.kind as 'video' | 'image' | undefined) ?? 'video'),
        linkMethod: 'operator_linked',
        trigger: 'link_external',
        linkedBy: { userId: member.userId, label: member.displayName, reason: input.reason },
        pageId: refs.pageId,
        postId: refs.postId,
        correlationId: meta.requestId,
      });
      return { state: 'published' as const, publicationId };
    }
    const { to, version } = await transitionDestination(tx, {
      postDestinationId,
      from: 'needs_reconciliation',
      trigger: 'close_not_published',
      reason: 'closed_not_published',
      now,
      set: { leaseOwner: null, leaseExpiresAt: null },
    });
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'publish.reconciliation_closed',
      entityType: 'post_destination',
      entityId: postDestinationId,
      pageId: refs.pageId,
      postId: refs.postId,
      data: { outcome: 'not_published', reason: input.reason },
      requestId: meta.requestId,
    });
    return { state: to, version };
  });
}
