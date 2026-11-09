import { AppError } from '@relay/domain';
import { accessiblePageIds, authorize, inWorkspace, type AuthenticatedUser } from './access';
import type { ServiceContext } from './context';

export type MediaUrlVariant = 'thumbnail' | 'proxy' | 'original';

export async function listAssets(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  pageId: string,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'media.view', pageId);
    const assets = await tx
      .selectFrom('mediaAssets')
      .select([
        'id',
        'kind',
        'status',
        'originalFilename',
        'declaredMime',
        'sizeBytes',
        'width',
        'height',
        'durationMs',
        'hasAudio',
        'rejectionCode',
        'rejectionDetail',
        'isSample',
        'createdAt',
        'validatedAt',
        'version',
      ])
      .where('pageId', '=', pageId)
      .where('status', '!=', 'deleted')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .execute();
    return { assets };
  });
}

export async function getAsset(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  assetId: string,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const asset = await tx
      .selectFrom('mediaAssets')
      .selectAll()
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!asset) throw new AppError('not_found', 'Media not found');
    authorize(member, 'media.view', asset.pageId);
    const variants = await tx
      .selectFrom('mediaVariants')
      .select(['id', 'kind', 'profile', 'mime', 'width', 'height', 'sizeBytes'])
      .where('assetId', '=', assetId)
      .execute();
    const grants = await tx
      .selectFrom('sourceRightsGrants')
      .select([
        'id',
        'grantType',
        'statementVersion',
        'canPublish',
        'canExport',
        'canCommercialUse',
        'permittedProviders',
        'validUntil',
        'revokedAt',
        'createdAt',
        'grantorUserId',
      ])
      .where('assetId', '=', assetId)
      .orderBy('createdAt')
      .execute();
    const job = await tx
      .selectFrom('jobRuns')
      .select(['id', 'status', 'progress', 'errorCode'])
      .where('entityType', '=', 'media_asset')
      .where('entityId', '=', assetId)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    const { objectKey: _k, objectVersionId: _v, objectEtag: _e, probe: _p, ...safe } = asset;
    return { asset: safe, variants, grants, job: job ?? null };
  });
}

/**
 * Mint a short-lived signed URL for one exact object version after authorising the caller
 * for the asset's page. URLs are never stored and never minted for assets that are still in
 * quarantine (originals become viewable only once validated).
 */
export async function mediaUrl(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  assetId: string,
  variant: MediaUrlVariant,
) {
  const target = await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const asset = await tx
      .selectFrom('mediaAssets')
      .select([
        'id',
        'pageId',
        'status',
        'objectKey',
        'objectVersionId',
        'declaredMime',
        'originalFilename',
      ])
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!asset) throw new AppError('not_found', 'Media not found');
    authorize(member, 'media.view', asset.pageId);
    if (asset.status !== 'ready')
      throw new AppError('media_not_ready', 'This media is still being validated or was rejected.');
    if (variant === 'original') {
      return {
        key: asset.objectKey,
        versionId: asset.objectVersionId,
        contentType: asset.declaredMime,
        filename: asset.originalFilename,
      };
    }
    const v = await tx
      .selectFrom('mediaVariants')
      .select(['objectKey', 'objectVersionId', 'mime'])
      .where('assetId', '=', assetId)
      .where('kind', '=', variant)
      .executeTakeFirst();
    if (!v) throw new AppError('not_found', 'This preview is not available for this media.');
    return {
      key: v.objectKey,
      versionId: v.objectVersionId,
      contentType: v.mime,
      filename: `${asset.originalFilename}-${variant}`,
    };
  });
  return ctx.storage.presignGet({
    key: target.key,
    versionId: target.versionId,
    expiresInSeconds: ctx.config.storage.mediaUrlTtlSeconds,
    contentType: target.contentType,
    disposition: 'inline',
    filename: target.filename,
  });
}

/** Thumbnail URLs for many assets at once (list views); silently skips unavailable ones. */
export async function thumbnailUrls(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  assetIds: string[],
): Promise<Record<string, string>> {
  if (assetIds.length === 0) return {};
  const rows = await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const visible = accessiblePageIds(member);
    let q = tx
      .selectFrom('mediaVariants as v')
      .innerJoin('mediaAssets as a', 'a.id', 'v.assetId')
      .select(['a.id', 'a.pageId', 'v.objectKey', 'v.objectVersionId', 'v.mime'])
      .where('a.id', 'in', [...new Set(assetIds)])
      .where('a.status', '=', 'ready')
      .where('v.kind', '=', 'thumbnail');
    if (visible)
      q = q.where(
        'a.pageId',
        'in',
        visible.length ? visible : ['00000000-0000-0000-0000-000000000000'],
      );
    return q.execute();
  });
  const out: Record<string, string> = {};
  await Promise.all(
    rows.map(async (r) => {
      const signed = await ctx.storage.presignGet({
        key: r.objectKey,
        versionId: r.objectVersionId,
        expiresInSeconds: ctx.config.storage.mediaUrlTtlSeconds,
        contentType: r.mime,
      });
      out[r.id] = signed.url;
    }),
  );
  return out;
}
