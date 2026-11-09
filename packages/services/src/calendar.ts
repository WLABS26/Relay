import {
  addDays,
  calendarQuerySchema,
  instantToZoned,
  localDate,
  STATE_LABELS,
  startOfLocalDay,
  type DestinationState,
  type WeekStart,
} from '@relay/domain';
import {
  accessiblePageIds,
  authorize,
  inWorkspace,
  requirePage,
  type AuthenticatedUser,
} from './access';
import { thumbnailUrls } from './assets';
import type { ServiceContext } from './context';

/**
 * Calendar read model: reservations (scheduled and historical) within a bounded local date
 * range, displayed in the page (or requested) zone. Proposals are not stored here — the UI
 * draws them separately and labels them as suggestions.
 */
export async function getCalendar(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawQuery: unknown,
) {
  const query = calendarQuerySchema.parse(rawQuery);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'workspace.view');
    const workspace = await tx
      .selectFrom('workspaces')
      .select(['timezone', 'weekStart'])
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    let zone = workspace.timezone;
    let weekStart = workspace.weekStart as WeekStart;
    if (query.pageId) {
      authorize(member, 'content.view', query.pageId);
      const page = await requirePage(tx, member, query.pageId);
      zone = page.timezone;
      weekStart = page.weekStart as WeekStart;
    }
    if (query.tz) zone = query.tz;
    const from = startOfLocalDay(query.from, zone);
    const to = startOfLocalDay(addDays(query.to, 1), zone);
    const visible = accessiblePageIds(member);

    let q = tx
      .selectFrom('slotReservations as s')
      .innerJoin('postDestinations as pd', 'pd.id', 's.postDestinationId')
      .innerJoin('posts as p', 'p.id', 'pd.postId')
      .innerJoin('pages as pg', 'pg.id', 'p.pageId')
      .innerJoin('pageDestinations as d', 'd.id', 's.pageDestinationId')
      .innerJoin('socialAccounts as a', 'a.id', 's.socialAccountId')
      .innerJoin('publishIntents as i', 'i.id', 's.intentId')
      .leftJoin('postRevisions as r', 'r.id', 'i.revisionId')
      .leftJoin('externalPublications as e', 'e.postDestinationId', 'pd.id')
      .leftJoin('postRevisionMedia as rm', (j) =>
        j.onRef('rm.revisionId', '=', 'i.revisionId').on('rm.position', '=', 0),
      )
      .leftJoin('postRevisionVariants as v', (j) =>
        j.onRef('v.revisionId', '=', 'i.revisionId').onRef('v.postDestinationId', '=', 'pd.id'),
      )
      .select([
        'pd.id as postDestinationId',
        'pd.state',
        'pd.stateReason',
        'pd.version',
        'p.id as postId',
        'p.title',
        'p.isSample',
        'pg.id as pageId',
        'pg.name as pageName',
        'd.id as destinationId',
        'd.label as destinationLabel',
        'd.provider',
        'a.connectionMode',
        'a.displayName as accountName',
        's.slotAt',
        's.locked',
        's.status as reservationStatus',
        'i.civilLocal',
        'i.civilOffset',
        'i.civilZone',
        'i.dispatchMode',
        'r.caption',
        'e.publishedAt',
        'e.permalink',
        'rm.assetId',
        'v.visibility',
      ])
      .where('s.status', 'in', ['active', 'consumed'])
      .where('s.slotAt', '>=', from)
      .where('s.slotAt', '<', to)
      .orderBy('s.slotAt');
    if (query.pageId) q = q.where('p.pageId', '=', query.pageId);
    if (query.destinationId) q = q.where('d.id', '=', query.destinationId);
    if (visible)
      q = q.where(
        'p.pageId',
        'in',
        visible.length ? visible : ['00000000-0000-0000-0000-000000000000'],
      );
    const rows = await q.execute();
    const thumbs = await thumbnailUrls(
      ctx,
      user,
      workspaceId,
      rows.map((r) => r.assetId).filter((x): x is string => Boolean(x)),
    ).catch(() => ({}) as Record<string, string>);
    const items = rows.map((r) => {
      const local = instantToZoned(r.slotAt, zone);
      return {
        postDestinationId: r.postDestinationId,
        postId: r.postId,
        version: r.version,
        title: r.title ?? (r.caption ? r.caption.slice(0, 60) : 'Untitled post'),
        captionPreview: r.caption ? r.caption.slice(0, 140) : '',
        isSample: r.isSample,
        pageId: r.pageId,
        pageName: r.pageName,
        destinationId: r.destinationId,
        destinationLabel: r.destinationLabel,
        provider: r.provider,
        connectionMode: r.connectionMode,
        accountName: r.accountName,
        visibility: r.visibility ?? 'public',
        state: r.state as DestinationState,
        stateLabel: STATE_LABELS[r.state as DestinationState],
        stateReason: r.stateReason,
        plannedAt: r.slotAt.toISOString(),
        localDate: local.civil.slice(0, 10),
        localTime: local.civil.slice(11, 16),
        offset: local.offset,
        chosenLocal: r.civilLocal,
        chosenZone: r.civilZone,
        dispatchMode: r.dispatchMode,
        locked: r.locked,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        permalink: r.permalink,
        thumbnailUrl: r.assetId ? (thumbs[r.assetId] ?? null) : null,
      };
    });
    const days: string[] = [];
    for (let d = query.from; d <= query.to; d = addDays(d, 1)) days.push(d);
    return {
      zone,
      weekStart,
      from: query.from,
      to: query.to,
      today: localDate(ctx.clock.now(), zone),
      days,
      items,
    };
  });
}
