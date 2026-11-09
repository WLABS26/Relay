import { withTenant, type Tx } from '@relay/db';
import {
  AppError,
  can,
  isPageScoped,
  roleSeesAllPages,
  type Action,
  type Role,
} from '@relay/domain';
import type { AuditActor } from './audit';
import type { ServiceContext } from './context';

/**
 * Authorization. Every workspace-scoped command runs inside `inWorkspace`, which opens the
 * tenant transaction, loads the caller's membership in that same transaction and hands the
 * command a Member to authorize against. Non-members — and members asking for pages they
 * cannot access — get `not_found`, never `forbidden`, so IDs from another tenant reveal
 * nothing about their existence.
 */

export interface AuthenticatedUser {
  userId: string;
  email: string;
  displayName: string;
  isDemo: boolean;
}

export interface Member {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  membershipId: string;
  membershipVersion: number;
  userId: string;
  displayName: string;
  role: Role;
  allPages: boolean;
  /** Explicit page grants (only meaningful when allPages is false). */
  pageIds: ReadonlySet<string>;
}

export function canAccessPage(member: Member, pageId: string): boolean {
  return roleSeesAllPages(member.role) || member.allPages || member.pageIds.has(pageId);
}

/** Throw unless the member may perform `action` (on `pageId` for page-scoped actions). */
export function authorize(member: Member, action: Action, pageId?: string | null): void {
  if (isPageScoped(action)) {
    if (!pageId) throw new Error(`authorize(${action}) requires a page id`);
    if (!canAccessPage(member, pageId)) throw new AppError('not_found', 'Page not found');
  }
  if (!can(member.role, action)) {
    throw new AppError('forbidden', `Your role (${member.role}) cannot do this.`, {
      details: { action },
    });
  }
}

/** Page IDs a member may see, or null meaning "all pages". */
export function accessiblePageIds(member: Member): string[] | null {
  if (roleSeesAllPages(member.role) || member.allPages) return null;
  return [...member.pageIds];
}

export function memberActor(member: Member): AuditActor {
  return { type: 'user', userId: member.userId, label: member.displayName };
}

export async function loadMember(
  tx: Tx,
  workspaceId: string,
  user: AuthenticatedUser,
): Promise<Member> {
  const row = await tx
    .selectFrom('workspaceMemberships as m')
    .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
    .select([
      'm.id as membershipId',
      'm.version as membershipVersion',
      'm.role',
      'm.allPages',
      'w.id as workspaceId',
      'w.slug',
      'w.name',
    ])
    .where('m.workspaceId', '=', workspaceId)
    .where('m.userId', '=', user.userId)
    .executeTakeFirst();
  if (!row) throw new AppError('not_found', 'Workspace not found');
  let pageIds: Set<string> = new Set();
  if (!row.allPages) {
    const pages = await tx
      .selectFrom('membershipPages')
      .select('pageId')
      .where('membershipId', '=', row.membershipId)
      .execute();
    pageIds = new Set(pages.map((p) => p.pageId));
  }
  return {
    workspaceId: row.workspaceId,
    workspaceSlug: row.slug,
    workspaceName: row.name,
    membershipId: row.membershipId,
    membershipVersion: row.membershipVersion,
    userId: user.userId,
    displayName: user.displayName,
    role: row.role as Role,
    allPages: row.allPages,
    pageIds,
  };
}

/** Run `fn` in the workspace's tenant transaction with the caller's verified membership. */
export async function inWorkspace<T>(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  fn: (tx: Tx, member: Member) => Promise<T>,
): Promise<T> {
  return withTenant(ctx.db, { workspaceId, userId: user.userId }, async (tx) => {
    const member = await loadMember(tx, workspaceId, user);
    return fn(tx, member);
  });
}

/** Load a page the member can access, or not_found. */
export async function requirePage(tx: Tx, member: Member, pageId: string) {
  if (!canAccessPage(member, pageId)) throw new AppError('not_found', 'Page not found');
  const page = await tx
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', pageId)
    .where('archivedAt', 'is', null)
    .executeTakeFirst();
  if (!page) throw new AppError('not_found', 'Page not found');
  return page;
}
