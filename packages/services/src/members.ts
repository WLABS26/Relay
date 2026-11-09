import { sql, withTenant, type Tx } from '@relay/db';
import {
  acceptInvitationSchema,
  AppError,
  assignableRoles,
  inviteMemberSchema,
  isUuid,
  roleSeesAllPages,
  updateMemberSchema,
  type Role,
} from '@relay/domain';
import { randomToken, sha256Bytes } from '@relay/domain/server';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser, type Member } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export async function listMembers(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'members.view');
    const members = await tx
      .selectFrom('workspaceMemberships as m')
      .innerJoin('users as u', 'u.id', 'm.userId')
      .select([
        'm.id',
        'm.role',
        'm.allPages',
        'm.version',
        'm.createdAt',
        'u.id as userId',
        'u.displayName',
        'u.email',
        'u.isDemo',
      ])
      .where('m.workspaceId', '=', workspaceId)
      .orderBy('u.displayName')
      .execute();
    const grants = await tx
      .selectFrom('membershipPages')
      .select(['membershipId', 'pageId'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    const invitations =
      member.role === 'owner' || member.role === 'admin'
        ? await tx
            .selectFrom('invitations')
            .select([
              'id',
              'emailNormalized',
              'role',
              'allPages',
              'pageIds',
              'createdAt',
              'expiresAt',
            ])
            .where('workspaceId', '=', workspaceId)
            .where('acceptedAt', 'is', null)
            .where('revokedAt', 'is', null)
            .orderBy('createdAt', 'desc')
            .execute()
        : [];
    return {
      member,
      members: members.map((m) => ({
        ...m,
        role: m.role as Role,
        pageIds: grants.filter((g) => g.membershipId === m.id).map((g) => g.pageId),
      })),
      invitations,
    };
  });
}

async function assertPagesExist(tx: Tx, pageIds: string[]): Promise<void> {
  if (pageIds.length === 0) return;
  const found = await tx.selectFrom('pages').select('id').where('id', 'in', pageIds).execute();
  if (found.length !== new Set(pageIds).size) {
    throw new AppError('validation_failed', 'One or more pages do not exist.', {
      fieldErrors: { pageIds: ['Unknown page'] },
    });
  }
}

function assertCanAssign(actor: Member, role: Role): void {
  if (!assignableRoles(actor.role).includes(role)) {
    throw new AppError('forbidden', `Your role cannot assign the ${role} role.`);
  }
}

export async function inviteMember(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = inviteMemberSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'members.manage');
    assertCanAssign(member, input.role);
    const allPages = roleSeesAllPages(input.role) ? true : input.allPages;
    const pageIds = allPages ? [] : [...new Set(input.pageIds)];
    if (!allPages && pageIds.length === 0) {
      throw new AppError(
        'validation_failed',
        'Choose at least one page or give access to all pages.',
        { fieldErrors: { pageIds: ['Required'] } },
      );
    }
    await assertPagesExist(tx, pageIds);
    const email = input.email.trim().toLowerCase();
    const existing = await tx
      .selectFrom('workspaceMemberships as m')
      .innerJoin('users as u', 'u.id', 'm.userId')
      .select('m.id')
      .where('m.workspaceId', '=', workspaceId)
      .where('u.emailNormalized', '=', email)
      .executeTakeFirst();
    if (existing)
      throw new AppError('already_member', 'That person is already a member of this workspace.');
    const now = ctx.clock.now();
    // Supersede any pending invitation for the same email.
    await tx
      .updateTable('invitations')
      .set({ revokedAt: now })
      .where('emailNormalized', '=', email)
      .where('acceptedAt', 'is', null)
      .where('revokedAt', 'is', null)
      .execute();
    // The token carries the workspace ID (a locator, not a secret) so acceptance can set the
    // tenant context before looking up the hashed secret part.
    const secret = randomToken(32);
    const token = `${workspaceId}.${secret}`;
    const id = ctx.ids.next();
    await tx
      .insertInto('invitations')
      .values({
        id,
        workspaceId,
        emailNormalized: email,
        role: input.role,
        allPages,
        pageIds,
        tokenHash: sha256Bytes(token),
        invitedBy: user.userId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      })
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'member.invited',
      entityType: 'invitation',
      entityId: id,
      data: { role: input.role, allPages, pageCount: pageIds.length },
      requestId: meta.requestId,
    });
    return { invitationId: id, token, acceptPath: `/invite/${encodeURIComponent(token)}` };
  });
}

export async function acceptInvitation(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const { token } = acceptInvitationSchema.parse(rawInput);
  const workspaceId = token.split('.')[0] ?? '';
  if (!isUuid(workspaceId))
    throw new AppError('invitation_invalid', 'This invitation is invalid or has expired.');
  return withTenant(ctx.db, { workspaceId, userId: user.userId }, async (tx) => {
    const now = ctx.clock.now();
    const invitation = await tx
      .selectFrom('invitations')
      .selectAll()
      .where('tokenHash', '=', sha256Bytes(token))
      .where('acceptedAt', 'is', null)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', now)
      .forUpdate()
      .executeTakeFirst();
    if (!invitation || invitation.emailNormalized !== user.email.toLowerCase()) {
      throw new AppError(
        'invitation_invalid',
        'This invitation is invalid, expired, or for a different email address.',
      );
    }
    // Explicit workspace scope: the read policy also shows the user's own memberships in
    // other workspaces, so RLS alone would make every second workspace look joined.
    const existing = await tx
      .selectFrom('workspaceMemberships')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', user.userId)
      .executeTakeFirst();
    if (existing)
      throw new AppError('already_member', 'You are already a member of this workspace.');
    const membershipId = ctx.ids.next();
    await tx
      .insertInto('workspaceMemberships')
      .values({
        id: membershipId,
        workspaceId,
        userId: user.userId,
        role: invitation.role,
        allPages: invitation.allPages,
      })
      .execute();
    // Pages deleted since the invitation are silently dropped (composite FK would reject them).
    const livePages = invitation.pageIds.length
      ? await tx.selectFrom('pages').select('id').where('id', 'in', invitation.pageIds).execute()
      : [];
    if (livePages.length) {
      await tx
        .insertInto('membershipPages')
        .values(livePages.map((p) => ({ workspaceId, membershipId, pageId: p.id })))
        .execute();
    }
    await tx
      .updateTable('invitations')
      .set({ acceptedAt: now, acceptedBy: user.userId })
      .where('id', '=', invitation.id)
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: { type: 'user', userId: user.userId, label: user.displayName },
      action: 'member.joined',
      entityType: 'membership',
      entityId: membershipId,
      data: { role: invitation.role, invitationId: invitation.id },
      requestId: meta.requestId,
    });
    const ws = await tx
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    return { workspaceId, slug: ws.slug };
  });
}

async function lockOwners(tx: Tx, workspaceId: string): Promise<number> {
  // Serialises concurrent owner changes (see also the deferred last-owner trigger).
  await tx
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .forUpdate()
    .execute();
  const row = await tx
    .selectFrom('workspaceMemberships')
    .select(({ fn }) => fn.countAll<number>().as('n'))
    .where('workspaceId', '=', workspaceId)
    .where('role', '=', 'owner')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function updateMember(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  membershipId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = updateMemberSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'members.manage');
    const owners = await lockOwners(tx, workspaceId);
    const target = await tx
      .selectFrom('workspaceMemberships')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', membershipId)
      .executeTakeFirst();
    if (!target) throw new AppError('not_found', 'Member not found');
    const nextRole = (input.role ?? target.role) as Role;
    if (target.role === 'owner' || nextRole === 'owner') {
      if (member.role !== 'owner')
        throw new AppError('forbidden', 'Only owners can change owner roles.');
    }
    assertCanAssign(member, nextRole);
    if (target.role === 'owner' && nextRole !== 'owner' && owners <= 1) {
      throw new AppError(
        'last_owner',
        'A workspace must keep at least one owner. Promote someone else first.',
      );
    }
    const allPages = roleSeesAllPages(nextRole) ? true : (input.allPages ?? target.allPages);
    const updated = await tx
      .updateTable('workspaceMemberships')
      .set({ role: nextRole, allPages, version: sql`version + 1` })
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', membershipId)
      .where('version', '=', input.expectedVersion)
      .returning(['version'])
      .executeTakeFirst();
    if (!updated)
      throw new AppError(
        'version_conflict',
        'This member changed since you loaded the page. Reload and try again.',
      );
    if (input.pageIds !== undefined || allPages) {
      const pageIds = allPages ? [] : [...new Set(input.pageIds ?? [])];
      await assertPagesExist(tx, pageIds);
      await tx
        .deleteFrom('membershipPages')
        .where('workspaceId', '=', workspaceId)
        .where('membershipId', '=', membershipId)
        .execute();
      if (pageIds.length)
        await tx
          .insertInto('membershipPages')
          .values(pageIds.map((pageId) => ({ workspaceId, membershipId, pageId })))
          .execute();
    }
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'member.updated',
      entityType: 'membership',
      entityId: membershipId,
      data: { from: target.role, to: nextRole, allPages },
      requestId: meta.requestId,
    });
    return { version: updated.version };
  });
}

export async function removeMember(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  membershipId: string,
  meta: RequestMeta,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const self = member.membershipId === membershipId;
    if (!self) authorize(member, 'members.manage');
    const owners = await lockOwners(tx, workspaceId);
    const target = await tx
      .selectFrom('workspaceMemberships')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', membershipId)
      .executeTakeFirst();
    if (!target) throw new AppError('not_found', 'Member not found');
    if (target.role === 'owner' && !self && member.role !== 'owner')
      throw new AppError('forbidden', 'Only owners can remove owners.');
    if (target.role === 'owner' && owners <= 1)
      throw new AppError('last_owner', 'The last owner cannot leave or be removed.');
    await tx
      .deleteFrom('workspaceMemberships')
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', membershipId)
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: self ? 'member.left' : 'member.removed',
      entityType: 'membership',
      entityId: membershipId,
      data: { role: target.role },
      requestId: meta.requestId,
    });
    return { removed: true };
  });
}

export async function revokeInvitation(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  invitationId: string,
  meta: RequestMeta,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'members.manage');
    const row = await tx
      .updateTable('invitations')
      .set({ revokedAt: ctx.clock.now() })
      .where('id', '=', invitationId)
      .where('acceptedAt', 'is', null)
      .where('revokedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new AppError('not_found', 'Invitation not found');
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'member.invitation_revoked',
      entityType: 'invitation',
      entityId: invitationId,
      requestId: meta.requestId,
    });
    return { revoked: true };
  });
}
