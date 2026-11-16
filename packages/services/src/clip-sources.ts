import { z } from 'zod';
import { AppError, can, type RankSummary } from '@relay/domain';
import { accessiblePageIds, authorize, inWorkspace, type AuthenticatedUser } from './access';
import { thumbnailUrlsIn } from './assets';
import type { ServiceContext } from './context';

/**
 * Read model for the "Find clips" list: the ready, uploaded videos a member may see, each with
 * the state of its newest analysis and the number of clips cut from it. One tenant transaction,
 * so the page needs a single round trip beyond the workspace shell.
 */

const LIST_LIMIT = 100;

const listClipSourcesSchema = z.strictObject({
  pageId: z.uuid().optional(),
});

export interface ClipSourceAnalysisSummary {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  /** Suggestions found; 0 until the analysis has succeeded. */
  candidateCount: number;
  /** Neither audio nor a scene change: nothing to rank, the UI offers a manual range. */
  noSignal: boolean;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ClipSourceSummary {
  id: string;
  pageId: string;
  originalFilename: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasAudio: boolean | null;
  isSample: boolean;
  createdAt: Date;
  /** Short-lived signed URL; null when the video has no thumbnail. */
  thumbnailUrl: string | null;
  /** The newest analysis, whatever its status; null when none was ever requested. */
  analysis: ClipSourceAnalysisSummary | null;
  clipCount: number;
}

export async function listClipSources(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawFilter: unknown = {},
): Promise<{ sources: ClipSourceSummary[] }> {
  const filter = listClipSourcesSchema.parse(rawFilter);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    if (filter.pageId) {
      authorize(member, 'media.view', filter.pageId);
    } else if (!can(member.role, 'media.view')) {
      throw new AppError('forbidden', `Your role (${member.role}) cannot do this.`, {
        details: { action: 'media.view' },
      });
    }
    const pageIds = accessiblePageIds(member);
    if (pageIds !== null && pageIds.length === 0) return { sources: [] };

    let query = tx
      .selectFrom('mediaAssets')
      .select([
        'id',
        'pageId',
        'originalFilename',
        'width',
        'height',
        'durationMs',
        'hasAudio',
        'isSample',
        'createdAt',
      ])
      .where('kind', '=', 'video')
      .where('status', '=', 'ready')
      // Rendered clips are media assets too, but they are results, not sources.
      .where('origin', '=', 'upload');
    if (pageIds !== null) query = query.where('pageId', 'in', pageIds);
    if (filter.pageId) query = query.where('pageId', '=', filter.pageId);
    const assets = await query
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(LIST_LIMIT)
      .execute();
    if (assets.length === 0) return { sources: [] };
    const assetIds = assets.map((a) => a.id);

    const analyses = await tx
      .selectFrom('mediaAnalyses')
      .distinctOn('assetId')
      .select(['id', 'assetId', 'status', 'errorCode', 'summary', 'createdAt', 'finishedAt'])
      .where('assetId', 'in', assetIds)
      // Newest first per asset, as in listCandidates, so both screens describe the same one.
      .orderBy('assetId')
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const analysisByAsset = new Map(analyses.map((a) => [a.assetId, a]));

    const clipCounts = await tx
      .selectFrom('clipProjects')
      .select(({ fn }) => ['sourceAssetId', fn.countAll<string>().as('n')])
      .where('sourceAssetId', 'in', assetIds)
      .where('archivedAt', 'is', null)
      .groupBy('sourceAssetId')
      .execute();
    const clipsByAsset = new Map(clipCounts.map((c) => [c.sourceAssetId, Number(c.n)]));

    const thumbnails = await thumbnailUrlsIn(ctx, tx, member, assetIds);

    return {
      sources: assets.map((asset) => {
        const analysis = analysisByAsset.get(asset.id);
        const summary = (analysis?.summary ?? null) as RankSummary | null;
        return {
          ...asset,
          thumbnailUrl: thumbnails[asset.id] ?? null,
          analysis: analysis
            ? {
                id: analysis.id,
                status: analysis.status as ClipSourceAnalysisSummary['status'],
                errorCode: analysis.errorCode,
                candidateCount: summary?.candidateCount ?? 0,
                noSignal: summary?.noSignal ?? false,
                createdAt: analysis.createdAt,
                finishedAt: analysis.finishedAt,
              }
            : null,
          clipCount: clipsByAsset.get(asset.id) ?? 0,
        };
      }),
    };
  });
}
