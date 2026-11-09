import { BLOCK_REASONS, STATE_LABELS, type DestinationState } from '@relay/domain';
import { accessiblePageIds, inWorkspace, type AuthenticatedUser } from './access';
import type { ServiceContext } from './context';

/** Everything that needs a person: reviews, blocks, failures, unknown outcomes, connections. */
export async function getInbox(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const visible = accessiblePageIds(member);
    let q = tx
      .selectFrom('postDestinations as pd')
      .innerJoin('posts as p', 'p.id', 'pd.postId')
      .innerJoin('pages as pg', 'pg.id', 'p.pageId')
      .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
      .innerJoin('socialAccounts as a', 'a.id', 'd.socialAccountId')
      .leftJoin('postRevisions as r', 'r.id', 'p.currentRevisionId')
      .leftJoin('publishIntents as i', 'i.id', 'pd.activeIntentId')
      .select([
        'pd.id', 'pd.state', 'pd.stateReason', 'pd.stateChangedAt', 'p.id as postId', 'p.title', 'r.caption', 'pg.id as pageId',
        'pg.name as pageName', 'd.label', 'd.provider', 'a.connectionMode', 'i.plannedAt',
      ])
      .where('pd.state', 'in', ['needs_review', 'changes_requested', 'blocked', 'failed', 'failed_permanent', 'needs_reconciliation'])
      .where('p.archivedAt', 'is', null)
      .orderBy('pd.stateChangedAt', 'desc')
      .limit(200);
    if (visible) q = q.where('p.pageId', 'in', visible.length ? visible : ['00000000-0000-0000-0000-000000000000']);
    const rows = await q.execute();
    const accounts = await tx
      .selectFrom('socialAccounts')
      .select(['id', 'provider', 'displayName', 'status', 'healthReason', 'connectionMode'])
      .where('status', '!=', 'active')
      .execute();
    const priority: Record<string, number> = { needs_reconciliation: 0, failed: 1, blocked: 2, failed_permanent: 3, needs_review: 4, changes_requested: 5 };
    return {
      member,
      items: rows
        .map((r) => ({
          ...r,
          stateLabel: STATE_LABELS[r.state as DestinationState],
          reasonLabel: r.stateReason && r.stateReason in BLOCK_REASONS ? BLOCK_REASONS[r.stateReason as keyof typeof BLOCK_REASONS] : null,
          plannedAt: r.plannedAt?.toISOString() ?? null,
        }))
        .sort((a, b) => (priority[a.state] ?? 9) - (priority[b.state] ?? 9)),
      accounts,
    };
  });
}
