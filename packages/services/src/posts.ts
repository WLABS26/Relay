import { sql, type Tx } from '@relay/db';
import {
  AppError,
  createPostSchema,
  normalizeText,
  rollupStates,
  STATE_LABELS,
  updatePostSchema,
  type DestinationState,
  type Visibility,
} from '@relay/domain';
import { accessiblePageIds, authorize, inWorkspace, memberActor, requirePage, type AuthenticatedUser, type Member } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { transitionDestination } from './destinations';
import { withIdempotency } from './idempotency';
import { buildDestinationIntent, loadDestinationTargets, loadRevisionBundle, type DestinationTarget } from './intents';
import { thumbnailUrls } from './assets';

/**
 * Posts and immutable revisions. A revision captures media versions (ordered), base copy,
 * declarations and per-destination variants. Editing creates a new revision; approvals are
 * invalidated exactly for the destinations whose normalised intent changed.
 */

interface ContentInput {
  title: string | null;
  caption: string;
  mediaAssetIds: string[];
  declarations: { paidPartnership: boolean; alteredOrSyntheticMedia: boolean; madeForKids: boolean | null };
  variants: Record<string, { caption?: string | null | undefined; title?: string | null | undefined; visibility?: Visibility | undefined; metadata?: Record<string, string | number | boolean | null> | undefined }>;
}

async function loadAssetsForRevision(tx: Tx, pageId: string, assetIds: string[]) {
  if (new Set(assetIds).size !== assetIds.length) {
    throw new AppError('validation_failed', 'The same media item was added twice.', { fieldErrors: { mediaAssetIds: ['Duplicate media'] } });
  }
  const assets = await tx.selectFrom('mediaAssets').select(['id', 'pageId', 'status', 'version', 'kind']).where('id', 'in', assetIds).execute();
  for (const id of assetIds) {
    const asset = assets.find((a) => a.id === id);
    if (!asset || asset.pageId !== pageId) throw new AppError('validation_failed', 'Some media was not found on this page.', { fieldErrors: { mediaAssetIds: ['Unknown media'] } });
    if (asset.status === 'rejected' || asset.status === 'deleted') {
      throw new AppError('validation_failed', 'Rejected or deleted media cannot be used.', { fieldErrors: { mediaAssetIds: ['Media unavailable'] } });
    }
  }
  return assetIds.map((id) => assets.find((a) => a.id === id)!);
}

async function writeRevision(
  tx: Tx,
  ctx: ServiceContext,
  input: { workspaceId: string; postId: string; revisionNumber: number; userId: string; content: ContentInput; targets: DestinationTarget[]; defaultVisibility: Map<string, Visibility> },
) {
  const revisionId = ctx.ids.next();
  await tx
    .insertInto('postRevisions')
    .values({
      id: revisionId,
      workspaceId: input.workspaceId,
      postId: input.postId,
      revisionNumber: input.revisionNumber,
      title: input.content.title?.trim() || null,
      caption: normalizeText(input.content.caption),
      declarations: JSON.stringify(input.content.declarations),
      createdBy: input.userId,
    })
    .execute();
  const assets = await tx.selectFrom('mediaAssets').select(['id', 'version']).where('id', 'in', input.content.mediaAssetIds).execute();
  await tx
    .insertInto('postRevisionMedia')
    .values(
      input.content.mediaAssetIds.map((assetId, position) => ({
        workspaceId: input.workspaceId,
        revisionId,
        position,
        assetId,
        assetVersion: assets.find((a) => a.id === assetId)!.version,
      })),
    )
    .execute();
  // Variants: every destination gets an explicit row (base copy unless overridden). They are
  // computed in memory first so each immutable row is written exactly once, together with the
  // creation-time intent payload/hash (lineage; approvals use a live recompute).
  const bundle = await loadRevisionBundle(tx, revisionId);
  for (const target of input.targets) {
    const v = input.content.variants[target.pageDestinationId] ?? {};
    bundle.variants.set(target.postDestinationId, {
      caption: normalizeText(v.caption ?? input.content.caption),
      title: (v.title ?? input.content.title)?.trim() || null,
      visibility: v.visibility ?? input.defaultVisibility.get(target.pageDestinationId) ?? 'public',
      metadata: v.metadata ?? {},
    });
  }
  const now = ctx.clock.now();
  const built = new Map<string, Awaited<ReturnType<typeof buildDestinationIntent>>>();
  for (const target of input.targets) {
    const intent = await buildDestinationIntent(tx, ctx, { workspaceId: input.workspaceId, bundle, target, at: now });
    built.set(target.postDestinationId, intent);
  }
  for (const target of input.targets) {
    const v = input.content.variants[target.pageDestinationId] ?? {};
    const intent = built.get(target.postDestinationId)!;
    await tx
      .insertInto('postRevisionVariants')
      .values({
        workspaceId: input.workspaceId,
        revisionId,
        postDestinationId: target.postDestinationId,
        caption: intent.payload.caption,
        title: intent.payload.title,
        visibility: intent.payload.visibility,
        metadata: JSON.stringify(v.metadata ?? {}),
        intentPayload: JSON.stringify(intent.payload),
        intentHash: intent.hash,
        validationIssues: JSON.stringify(intent.issues),
      })
      .execute();
  }
  return { revisionId, built };
}

export async function createPost(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta & { idempotencyKey?: string | null },
  options: { isSample?: boolean } = {},
) {
  const input = createPostSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'content.create', input.pageId);
    await requirePage(tx, member, input.pageId);
    return withIdempotency(tx, { workspaceId, operation: 'posts.create', key: meta.idempotencyKey, actorUserId: user.userId, payload: input }, async () => {
      await loadAssetsForRevision(tx, input.pageId, input.mediaAssetIds);
      const destinations = await tx
        .selectFrom('pageDestinations')
        .select(['id', 'defaultVisibility', 'enabled', 'archivedAt', 'pageId'])
        .where('id', 'in', input.destinationIds)
        .execute();
      if (destinations.length !== new Set(input.destinationIds).size || destinations.some((d) => d.pageId !== input.pageId || d.archivedAt || !d.enabled)) {
        throw new AppError('validation_failed', 'Choose destinations that belong to this page.', { fieldErrors: { destinationIds: ['Unknown destination'] } });
      }
      if (input.campaignId) {
        const campaign = await tx.selectFrom('campaigns').select(['id', 'pageId']).where('id', '=', input.campaignId).where('archivedAt', 'is', null).executeTakeFirst();
        if (!campaign || (campaign.pageId && campaign.pageId !== input.pageId)) throw new AppError('validation_failed', 'Unknown campaign.', { fieldErrors: { campaignId: ['Unknown campaign'] } });
      }
      const postId = ctx.ids.next();
      await tx
        .insertInto('posts')
        .values({ id: postId, workspaceId, pageId: input.pageId, campaignId: input.campaignId, title: input.title?.trim() || null, createdBy: user.userId, isSample: options.isSample ?? false })
        .execute();
      for (const d of destinations) {
        await tx.insertInto('postDestinations').values({ id: ctx.ids.next(), workspaceId, postId, pageDestinationId: d.id, state: 'draft' }).execute();
      }
      const targets = await loadDestinationTargets(tx, postId);
      const { revisionId } = await writeRevision(tx, ctx, {
        workspaceId,
        postId,
        revisionNumber: 1,
        userId: user.userId,
        content: input,
        targets,
        defaultVisibility: new Map(destinations.map((d) => [d.id, d.defaultVisibility as Visibility])),
      });
      await tx.updateTable('posts').set({ currentRevisionId: revisionId }).where('id', '=', postId).execute();
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: memberActor(member),
        action: 'post.created',
        entityType: 'post',
        entityId: postId,
        pageId: input.pageId,
        postId,
        data: { revisionId, destinations: destinations.length, media: input.mediaAssetIds.length },
        requestId: meta.requestId,
      });
      return { status: 201, body: { postId, revisionId } };
    });
  });
}

export async function updatePost(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, postId: string, rawInput: unknown, meta: RequestMeta) {
  const input = updatePostSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const post = await tx.selectFrom('posts').selectAll().where('id', '=', postId).where('archivedAt', 'is', null).forUpdate().executeTakeFirst();
    if (!post) throw new AppError('not_found', 'Post not found');
    authorize(member, 'content.edit', post.pageId);
    if (post.version !== input.expectedVersion) {
      throw new AppError('version_conflict', 'Someone else edited this post. Reload to see their changes.');
    }
    await loadAssetsForRevision(tx, post.pageId, input.mediaAssetIds);
    const destinations = await tx
      .selectFrom('postDestinations')
      .select(['id', 'state', 'activeIntentId'])
      .where('postId', '=', postId)
      .forUpdate()
      .execute();
    const inFlight = destinations.filter((d) => ['preparing', 'dispatching', 'processing', 'needs_reconciliation'].includes(d.state));
    if (inFlight.length > 0) {
      throw new AppError('invalid_transition', 'A destination is being published or needs reconciliation. Unschedule or resolve it before editing.', {
        details: { postDestinationIds: inFlight.map((d) => d.id) },
      });
    }
    const latest = await tx.selectFrom('postRevisions').select(({ fn }) => fn.max('revisionNumber').as('n')).where('postId', '=', postId).executeTakeFirstOrThrow();
    const targets = await loadDestinationTargets(tx, postId);
    const pageDefaults = await tx.selectFrom('pageDestinations').select(['id', 'defaultVisibility']).where('pageId', '=', post.pageId).execute();
    const { revisionId, built } = await writeRevision(tx, ctx, {
      workspaceId,
      postId,
      revisionNumber: Number(latest.n ?? 0) + 1,
      userId: user.userId,
      content: input,
      targets,
      defaultVisibility: new Map(pageDefaults.map((d) => [d.id, d.defaultVisibility as Visibility])),
    });
    const now = ctx.clock.now();
    const outcomes: Array<{ postDestinationId: string; approvalKept: boolean; state: DestinationState }> = [];
    for (const d of destinations) {
      const state = d.state as DestinationState;
      const approval = await tx
        .selectFrom('approvals')
        .select(['id', 'intentHash'])
        .where('postDestinationId', '=', d.id)
        .where('decision', '=', 'approved')
        .where('invalidatedAt', 'is', null)
        .executeTakeFirst();
      const newHash = built.get(d.id)!.hash;
      if (approval && approval.intentHash === newHash) {
        outcomes.push({ postDestinationId: d.id, approvalKept: true, state });
        continue; // nothing this destination publishes changed
      }
      if (state === 'published' || state === 'canceled') {
        outcomes.push({ postDestinationId: d.id, approvalKept: false, state });
        continue;
      }
      if (approval) {
        await tx.updateTable('approvals').set({ invalidatedAt: now, invalidatedReason: 'payload_changed' }).where('id', '=', approval.id).execute();
      }
      if (d.activeIntentId) {
        await tx.updateTable('publishIntents').set({ status: 'canceled', endedAt: now, endReason: 'payload_changed' }).where('id', '=', d.activeIntentId).where('status', '=', 'active').execute();
        await tx.updateTable('slotReservations').set({ status: 'released', releasedAt: now, releaseReason: 'payload_changed' }).where('postDestinationId', '=', d.id).where('status', '=', 'active').execute();
      }
      const { to } = await transitionDestination(tx, {
        postDestinationId: d.id,
        from: state,
        trigger: 'edit',
        reason: approval ? 'approval_invalidated' : null,
        now,
        set: d.activeIntentId ? { activeIntentId: null, checkpointPhase: null, checkpointReceiptId: null, checkpointProviderPostId: null, checkpointNextCheckAt: null, attemptCount: 0 } : {},
      });
      outcomes.push({ postDestinationId: d.id, approvalKept: false, state: to });
    }
    const updated = await tx
      .updateTable('posts')
      .set({ currentRevisionId: revisionId, title: input.title?.trim() || null, version: sql`version + 1` })
      .where('id', '=', postId)
      .returning(['version'])
      .executeTakeFirstOrThrow();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'post.revised',
      entityType: 'post',
      entityId: postId,
      pageId: post.pageId,
      postId,
      data: { revisionId, invalidated: outcomes.filter((o) => !o.approvalKept && o.state !== 'published').length },
      requestId: meta.requestId,
    });
    return { revisionId, version: updated.version, destinations: outcomes };
  });
}

export async function listPosts(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  filters: { pageId?: string | undefined; state?: DestinationState | undefined; limit?: number },
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    if (filters.pageId) authorize(member, 'content.view', filters.pageId);
    const visible = accessiblePageIds(member);
    let q = tx
      .selectFrom('posts as p')
      .innerJoin('pages as pg', 'pg.id', 'p.pageId')
      .leftJoin('postRevisions as r', 'r.id', 'p.currentRevisionId')
      .select(['p.id', 'p.title', 'p.pageId', 'pg.name as pageName', 'p.isSample', 'p.version', 'p.createdAt', 'p.updatedAt', 'r.caption', 'r.revisionNumber'])
      .where('p.archivedAt', 'is', null)
      .orderBy('p.updatedAt', 'desc')
      .limit(filters.limit ?? 100);
    if (filters.pageId) q = q.where('p.pageId', '=', filters.pageId);
    if (visible) q = q.where('p.pageId', 'in', visible.length ? visible : ['00000000-0000-0000-0000-000000000000']);
    const posts = await q.execute();
    const ids = posts.map((p) => p.id);
    const dests = ids.length
      ? await tx
          .selectFrom('postDestinations as pd')
          .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
          .leftJoin('publishIntents as i', 'i.id', 'pd.activeIntentId')
          .select(['pd.id', 'pd.postId', 'pd.state', 'pd.stateReason', 'd.label', 'd.provider', 'i.plannedAt'])
          .where('pd.postId', 'in', ids)
          .execute()
      : [];
    const firstMedia = ids.length
      ? await tx
          .selectFrom('posts as p')
          .innerJoin('postRevisionMedia as rm', (j) => j.onRef('rm.revisionId', '=', 'p.currentRevisionId').on('rm.position', '=', 0))
          .select(['p.id as postId', 'rm.assetId'])
          .where('p.id', 'in', ids)
          .execute()
      : [];
    const thumbs = await thumbnailUrls(ctx, user, workspaceId, firstMedia.map((m) => m.assetId)).catch(() => ({}) as Record<string, string>);
    const items = posts.map((p) => {
      const d = dests.filter((x) => x.postId === p.id);
      const filtered = filters.state ? d.some((x) => x.state === filters.state) : true;
      const asset = firstMedia.find((m) => m.postId === p.id)?.assetId;
      return filtered
        ? {
            ...p,
            destinations: d.map((x) => ({ ...x, stateLabel: STATE_LABELS[x.state as DestinationState] })),
            rollup: rollupStates(d.map((x) => x.state as DestinationState)),
            thumbnailUrl: asset ? (thumbs[asset] ?? null) : null,
          }
        : null;
    });
    return { member, posts: items.filter((x): x is NonNullable<typeof x> => x !== null) };
  });
}

export async function loadPostForMember(tx: Tx, member: Member, postId: string) {
  const post = await tx.selectFrom('posts').selectAll().where('id', '=', postId).where('archivedAt', 'is', null).executeTakeFirst();
  if (!post) throw new AppError('not_found', 'Post not found');
  authorize(member, 'content.view', post.pageId);
  return post;
}

export async function getPostDetail(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, postId: string) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const post = await loadPostForMember(tx, member, postId);
    if (!post.currentRevisionId) throw new AppError('not_found', 'Post not found');
    const page = await tx.selectFrom('pages').select(['id', 'name', 'timezone', 'weekStart', 'pausedAt', 'currentPolicyRevision']).where('id', '=', post.pageId).executeTakeFirstOrThrow();
    const bundle = await loadRevisionBundle(tx, post.currentRevisionId);
    const targets = await loadDestinationTargets(tx, postId);
    const now = ctx.clock.now();
    const rows = await tx
      .selectFrom('postDestinations as pd')
      .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
      .leftJoin('publishIntents as i', 'i.id', 'pd.activeIntentId')
      .leftJoin('slotReservations as s', (j) => j.onRef('s.postDestinationId', '=', 'pd.id').on('s.status', '=', 'active'))
      .leftJoin('externalPublications as e', 'e.postDestinationId', 'pd.id')
      .select([
        'pd.id', 'pd.state', 'pd.stateReason', 'pd.stateChangedAt', 'pd.version', 'pd.checkpointPhase', 'pd.attemptCount',
        'd.id as pageDestinationId', 'd.label', 'd.provider',
        'i.id as intentId', 'i.intentVersion', 'i.plannedAt', 'i.civilLocal', 'i.civilZone', 'i.civilOffset', 'i.dispatchMode', 'i.intentHash as scheduledHash',
        's.locked', 's.slotAt',
        'e.externalId', 'e.permalink', 'e.publishedAt', 'e.visibility as publishedVisibility', 'e.linkMethod', 'e.connectionMode as publishedMode',
      ])
      .where('pd.postId', '=', postId)
      .orderBy('d.label')
      .execute();
    const approvals = await tx
      .selectFrom('approvals as a')
      .innerJoin('users as u', 'u.id', 'a.decidedBy')
      .select(['a.id', 'a.postDestinationId', 'a.decision', 'a.intentHash', 'a.note', 'a.decidedAt', 'a.invalidatedAt', 'a.invalidatedReason', 'a.windowStartsAt', 'a.windowEndsAt', 'a.revisionId', 'u.displayName as decidedByName'])
      .where('a.postDestinationId', 'in', rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'])
      .orderBy('a.decidedAt', 'desc')
      .execute();
    const attempts = await tx
      .selectFrom('publishAttempts')
      .select(['id', 'postDestinationId', 'attemptNumber', 'phase', 'status', 'errorCode', 'errorMessage', 'startedAt', 'finishedAt', 'retryAfter', 'providerPostId'])
      .where('postDestinationId', 'in', rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'])
      .orderBy('startedAt', 'desc')
      .limit(100)
      .execute();
    const destinations = [];
    for (const row of rows) {
      const target = targets.find((t) => t.postDestinationId === row.id)!;
      const intent = await buildDestinationIntent(tx, ctx, { workspaceId, bundle, target, at: now });
      const validApproval = approvals.find((a) => a.postDestinationId === row.id && a.decision === 'approved' && !a.invalidatedAt) ?? null;
      destinations.push({
        ...row,
        stateLabel: STATE_LABELS[row.state as DestinationState],
        account: target.account,
        intentHash: intent.hash,
        payload: intent.payload,
        format: intent.format,
        issues: intent.issues,
        mediaReady: intent.mediaReady,
        approval: validApproval,
        approvalStale: Boolean(validApproval && validApproval.intentHash !== intent.hash),
        approvals: approvals.filter((a) => a.postDestinationId === row.id),
        attempts: attempts.filter((a) => a.postDestinationId === row.id),
      });
    }
    const timeline = await tx
      .selectFrom('auditEvents')
      .select(['id', 'occurredAt', 'actorType', 'actorLabel', 'action', 'entityType', 'entityId', 'data'])
      .where('postId', '=', postId)
      .orderBy('occurredAt', 'asc')
      .limit(500)
      .execute();
    const mediaTimeline = await tx
      .selectFrom('auditEvents')
      .select(['id', 'occurredAt', 'actorType', 'actorLabel', 'action', 'entityType', 'entityId', 'data'])
      .where('entityType', '=', 'media_asset')
      .where('entityId', 'in', bundle.media.length ? bundle.media.map((m) => m.assetId) : ['00000000-0000-0000-0000-000000000000'])
      .orderBy('occurredAt', 'asc')
      .execute();
    const revisions = await tx.selectFrom('postRevisions as r').innerJoin('users as u', 'u.id', 'r.createdBy').select(['r.id', 'r.revisionNumber', 'r.createdAt', 'u.displayName']).where('r.postId', '=', postId).orderBy('r.revisionNumber', 'desc').execute();
    const thumbs = await thumbnailUrls(ctx, user, workspaceId, bundle.media.map((m) => m.assetId)).catch(() => ({}) as Record<string, string>);
    return {
      member,
      post,
      page,
      revision: bundle.revision,
      revisions,
      media: bundle.media.map((m) => ({ ...m, thumbnailUrl: thumbs[m.assetId] ?? null })),
      destinations,
      rollup: rollupStates(destinations.map((d) => d.state as DestinationState)),
      timeline: [...mediaTimeline, ...timeline].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    };
  });
}
