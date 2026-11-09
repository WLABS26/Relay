import { sql, type Tx } from '@relay/db';
import {
  AppError,
  createPageSchema,
  DEFAULT_PUBLISHING_RULES,
  normalizeTimeZone,
  publishingRulesSchema,
  putPublishingRulesSchema,
  updatePageSchema,
  type PublishingRules,
} from '@relay/domain';
import {
  accessiblePageIds,
  authorize,
  inWorkspace,
  memberActor,
  requirePage,
  type AuthenticatedUser,
} from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { enqueue } from './tasks';

export async function loadRules(
  tx: Tx,
  pageId: string,
): Promise<{ revision: number; rules: PublishingRules }> {
  const row = await tx
    .selectFrom('pages as p')
    .leftJoin('pagePolicyRevisions as r', (j) =>
      j.onRef('r.pageId', '=', 'p.id').onRef('r.revision', '=', 'p.currentPolicyRevision'),
    )
    .select(['p.currentPolicyRevision', 'r.rules'])
    .where('p.id', '=', pageId)
    .executeTakeFirst();
  if (!row) throw new AppError('not_found', 'Page not found');
  if (!row.rules) return { revision: 0, rules: DEFAULT_PUBLISHING_RULES };
  return { revision: row.currentPolicyRevision, rules: publishingRulesSchema.parse(row.rules) };
}

export async function listPages(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'workspace.view');
    const visible = accessiblePageIds(member);
    let q = tx
      .selectFrom('pages')
      .select([
        'id',
        'name',
        'timezone',
        'weekStart',
        'goal',
        'isSample',
        'pausedAt',
        'pauseReason',
        'allowedFormats',
        'currentPolicyRevision',
      ])
      .where('archivedAt', 'is', null)
      .orderBy('name');
    if (visible)
      q = q.where(
        'id',
        'in',
        visible.length > 0 ? visible : ['00000000-0000-0000-0000-000000000000'],
      );
    const pages = await q.execute();
    const destinations = await tx
      .selectFrom('pageDestinations as d')
      .innerJoin('socialAccounts as a', 'a.id', 'd.socialAccountId')
      .select([
        'd.id',
        'd.pageId',
        'd.label',
        'd.provider',
        'd.defaultVisibility',
        'd.enabled',
        'a.id as socialAccountId',
        'a.displayName as accountName',
        'a.handle',
        'a.connectionMode',
        'a.status as accountStatus',
        'a.simulatorProfile',
      ])
      .where('d.archivedAt', 'is', null)
      .orderBy('d.label')
      .execute();
    return {
      member,
      pages: pages.map((p) => ({
        ...p,
        destinations: destinations.filter((d) => d.pageId === p.id),
      })),
    };
  });
}

export async function createPage(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta,
  options: { isSample?: boolean } = {},
) {
  const input = createPageSchema.parse(rawInput);
  const timezone = normalizeTimeZone(input.timezone);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'pages.create');
    const id = ctx.ids.next();
    await tx
      .insertInto('pages')
      .values({
        id,
        workspaceId,
        name: input.name,
        timezone,
        weekStart: input.weekStart,
        goal: input.goal,
        topics: input.topics,
        contentPillars: input.contentPillars,
        allowedFormats: input.allowedFormats,
        isSample: options.isSample ?? false,
        currentPolicyRevision: 1,
      })
      .execute();
    await tx
      .insertInto('pagePolicyRevisions')
      .values({
        id: ctx.ids.next(),
        workspaceId,
        pageId: id,
        revision: 1,
        rules: JSON.stringify(DEFAULT_PUBLISHING_RULES),
        createdBy: user.userId,
      })
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'page.created',
      entityType: 'page',
      entityId: id,
      pageId: id,
      data: { name: input.name, timezone },
      requestId: meta.requestId,
    });
    return { id };
  });
}

export async function getPageDetail(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  pageId: string,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'page.view', pageId);
    const page = await requirePage(tx, member, pageId);
    const { revision, rules } = await loadRules(tx, pageId);
    const revisions = await tx
      .selectFrom('pagePolicyRevisions')
      .select(['revision', 'createdAt', 'createdBy'])
      .where('pageId', '=', pageId)
      .orderBy('revision', 'desc')
      .limit(10)
      .execute();
    return { member, page, rules, revision, revisions };
  });
}

export async function updatePage(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  pageId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = updatePageSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'page.update', pageId);
    await requirePage(tx, member, pageId);
    const { expectedVersion, timezone, ...rest } = input;
    const updated = await tx
      .updateTable('pages')
      .set({
        ...rest,
        ...(timezone ? { timezone: normalizeTimeZone(timezone) } : {}),
        version: sql`version + 1`,
      })
      .where('id', '=', pageId)
      .where('version', '=', expectedVersion)
      .returning(['version', 'timezone'])
      .executeTakeFirst();
    if (!updated)
      throw new AppError(
        'version_conflict',
        'This page changed since you loaded it. Reload and try again.',
      );
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'page.updated',
      entityType: 'page',
      entityId: pageId,
      pageId,
      // A zone change never moves existing schedules: they keep their UTC instants.
      data: { fields: Object.keys(rest).concat(timezone ? ['timezone'] : []) },
      requestId: meta.requestId,
    });
    return updated;
  });
}

/** Publishing rules are immutable revisions; this creates revision N+1. */
export async function putPublishingRules(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  pageId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = putPublishingRulesSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'page.rules.update', pageId);
    await requirePage(tx, member, pageId);
    if (input.rules.automation.mode !== 'off' && !['owner', 'admin'].includes(member.role)) {
      throw new AppError('forbidden', 'Only owners and admins can change automation.');
    }
    const locked = await tx
      .selectFrom('pages')
      .select('currentPolicyRevision')
      .where('id', '=', pageId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.currentPolicyRevision !== input.expectedRevision) {
      throw new AppError(
        'version_conflict',
        'The publishing rules changed since you loaded them. Reload and try again.',
      );
    }
    const revision = locked.currentPolicyRevision + 1;
    await tx
      .insertInto('pagePolicyRevisions')
      .values({
        id: ctx.ids.next(),
        workspaceId,
        pageId,
        revision,
        rules: JSON.stringify(input.rules),
        createdBy: user.userId,
      })
      .execute();
    await tx
      .updateTable('pages')
      .set({ currentPolicyRevision: revision, version: sql`version + 1` })
      .where('id', '=', pageId)
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'page.rules_revised',
      entityType: 'page',
      entityId: pageId,
      pageId,
      data: { revision },
      requestId: meta.requestId,
    });
    return { revision };
  });
}

/**
 * Pause bumps the page's pause generation. Dispatch claims take a FOR SHARE lock on the page
 * row and re-check it, so a pause that commits first prevents any later claim; a claim that
 * committed first is already in flight and is reported back here rather than hidden.
 */
export async function setPagePaused(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  pageId: string,
  paused: boolean,
  reason: string | undefined,
  meta: RequestMeta,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, paused ? 'page.pause' : 'page.resume', pageId);
    await requirePage(tx, member, pageId);
    const now = ctx.clock.now();
    const row = await tx
      .updateTable('pages')
      .set(
        paused
          ? {
              pausedAt: now,
              pausedBy: user.userId,
              pauseReason: reason ?? null,
              pauseGeneration: sql`pause_generation + 1`,
              version: sql`version + 1`,
            }
          : { pausedAt: null, pausedBy: null, pauseReason: null, version: sql`version + 1` },
      )
      .where('id', '=', pageId)
      .returning(['pausedAt', 'pauseGeneration'])
      .executeTakeFirstOrThrow();

    const destinations = await tx
      .selectFrom('postDestinations as pd')
      .innerJoin('posts as p', 'p.id', 'pd.postId')
      .select(['pd.id', 'pd.state', 'pd.stateReason', 'pd.activeIntentId'])
      .where('p.pageId', '=', pageId)
      .where('pd.state', 'in', ['scheduled', 'preparing', 'dispatching', 'processing', 'blocked'])
      .execute();
    const inFlight = destinations.filter(
      (d) => d.state === 'dispatching' || d.state === 'processing',
    );
    let resumed = 0;
    if (!paused) {
      // Destinations held by the pause continue if their intent is still active; the worker
      // re-checks lateness and routes anything past the grace window to review.
      for (const d of destinations.filter(
        (x) => x.state === 'blocked' && x.stateReason === 'page_paused' && x.activeIntentId,
      )) {
        const intent = await tx
          .selectFrom('publishIntents')
          .select(['id', 'intentVersion'])
          .where('id', '=', d.activeIntentId!)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!intent) continue;
        await tx
          .updateTable('postDestinations')
          .set({
            state: 'scheduled',
            stateReason: null,
            stateChangedAt: now,
            version: sql`version + 1`,
          })
          .where('id', '=', d.id)
          .where('state', '=', 'blocked')
          .execute();
        await enqueue(
          tx,
          'publish.advance',
          {
            workspaceId,
            postDestinationId: d.id,
            intentId: intent.id,
            intentVersion: intent.intentVersion,
          },
          { jobKey: `publish:${d.id}` },
        );
        resumed++;
      }
    }
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: paused ? 'page.paused' : 'page.resumed',
      entityType: 'page',
      entityId: pageId,
      pageId,
      data: {
        reason: reason ?? null,
        pauseGeneration: row.pauseGeneration,
        inFlight: inFlight.length,
        resumed,
      },
      requestId: meta.requestId,
    });
    return {
      pausedAt: row.pausedAt,
      pauseGeneration: row.pauseGeneration,
      inFlight: inFlight.map((d) => ({ postDestinationId: d.id, state: d.state })),
      held: destinations.filter((d) => d.state === 'scheduled' || d.state === 'preparing').length,
      resumed,
    };
  });
}
