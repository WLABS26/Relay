import { sql, withTenant, withUser } from '@relay/db';
import { AppError, createWorkspaceSchema, normalizeTimeZone, type Role } from '@relay/domain';
import { appendAudit } from './audit';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser } from './access';
import type { RequestMeta, ServiceContext } from './context';

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: Role;
  isDemo: boolean;
  timezone: string;
  weekStart: 'monday' | 'sunday';
  pausedAt: Date | null;
}

/** Workspaces the user belongs to (workspace switcher). Uses the user context only. */
export async function listMyWorkspaces(ctx: ServiceContext, user: AuthenticatedUser): Promise<WorkspaceSummary[]> {
  return withUser(ctx.db, user.userId, async (tx) => {
    const rows = await tx
      .selectFrom('workspaceMemberships as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
      .select(['w.id', 'w.slug', 'w.name', 'm.role', 'w.isDemo', 'w.timezone', 'w.weekStart', 'w.pausedAt'])
      .where('m.userId', '=', user.userId)
      .orderBy('w.name')
      .execute();
    return rows.map((r) => ({ ...r, role: r.role as Role, weekStart: r.weekStart as 'monday' | 'sunday' }));
  });
}

/**
 * Resolve a URL slug to a workspace ID for the signed-in user. A slug is only a locator:
 * authorization always happens again against the membership inside the tenant transaction.
 */
export async function resolveWorkspaceSlug(ctx: ServiceContext, user: AuthenticatedUser, slug: string): Promise<string> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new AppError('not_found', 'Workspace not found');
  const row = await withUser(ctx.db, user.userId, (tx) =>
    tx
      .selectFrom('workspaces as w')
      .innerJoin('workspaceMemberships as m', (j) => j.onRef('m.workspaceId', '=', 'w.id').on('m.userId', '=', user.userId))
      .select('w.id')
      .where('w.slug', '=', slug)
      .executeTakeFirst(),
  );
  if (!row) throw new AppError('not_found', 'Workspace not found');
  return row.id;
}

export async function createWorkspace(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  rawInput: unknown,
  meta: RequestMeta,
  options: { isDemo?: boolean } = {},
): Promise<{ id: string; slug: string }> {
  const input = createWorkspaceSchema.parse(rawInput);
  const timezone = normalizeTimeZone(input.timezone);
  const id = ctx.ids.next();
  try {
    await withTenant(ctx.db, { workspaceId: id, userId: user.userId }, async (tx) => {
      await tx
        .insertInto('workspaces')
        .values({
          id,
          slug: input.slug,
          name: input.name,
          timezone,
          weekStart: input.weekStart,
          isDemo: options.isDemo ?? false,
          storageQuotaBytes: ctx.config.uploads.workspaceStorageQuotaBytes,
        })
        .execute();
      await tx
        .insertInto('workspaceMemberships')
        .values({ id: ctx.ids.next(), workspaceId: id, userId: user.userId, role: 'owner', allPages: true })
        .execute();
      await appendAudit(tx, ctx.ids, {
        workspaceId: id,
        actor: { type: 'user', userId: user.userId, label: user.displayName },
        action: 'workspace.created',
        entityType: 'workspace',
        entityId: id,
        data: { slug: input.slug },
        requestId: meta.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'workspaces_slug_key')) {
      throw new AppError('validation_failed', 'That workspace address is taken.', { fieldErrors: { slug: ['Already in use'] } });
    }
    throw error;
  }
  return { id, slug: input.slug };
}

export async function getWorkspace(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'workspace.view');
    const ws = await tx.selectFrom('workspaces').selectAll().where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return { workspace: ws, member };
  });
}

export async function setWorkspacePaused(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  paused: boolean,
  reason: string | undefined,
  meta: RequestMeta,
): Promise<{ pausedAt: Date | null; pauseGeneration: number; inFlight: number }> {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'workspace.pause');
    const now = ctx.clock.now();
    const row = await tx
      .updateTable('workspaces')
      .set(
        paused
          ? { pausedAt: now, pauseReason: reason ?? null, pauseGeneration: sql`pause_generation + 1`, version: sql`version + 1` }
          : { pausedAt: null, pauseReason: null, version: sql`version + 1` },
      )
      .where('id', '=', workspaceId)
      .returning(['pausedAt', 'pauseGeneration'])
      .executeTakeFirstOrThrow();
    const inFlight = await tx
      .selectFrom('postDestinations')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('state', 'in', ['dispatching', 'processing'])
      .executeTakeFirstOrThrow();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: paused ? 'workspace.paused' : 'workspace.resumed',
      entityType: 'workspace',
      entityId: workspaceId,
      data: { reason: reason ?? null, pauseGeneration: row.pauseGeneration, inFlight: Number(inFlight.n) },
      requestId: meta.requestId,
    });
    return { pausedAt: row.pausedAt, pauseGeneration: row.pauseGeneration, inFlight: Number(inFlight.n) };
  });
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return Boolean(e && e.code === '23505' && (!constraint || e.constraint === constraint));
}

export function isExclusionOrCheck(error: unknown): boolean {
  const e = error as { code?: string } | null;
  return Boolean(e && (e.code === '23514' || e.code === '23P01'));
}
