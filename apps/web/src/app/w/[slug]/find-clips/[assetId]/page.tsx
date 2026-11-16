import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { can, isAppError, isUuid } from '@relay/domain';
import { getAsset } from '@relay/services';
import { Banner, SampleBadge } from '@relay/ui';
import { SourceWorkspace } from '@/components/clips/SourceWorkspace';
import { formatDuration } from '@/lib/format';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Suggested clips' };

export default async function SourcePage({
  params,
}: {
  params: Promise<{ slug: string; assetId: string }>;
}) {
  const { slug, assetId } = await params;
  if (!isUuid(assetId)) notFound();
  const wc = await loadWorkspace(slug);
  let asset;
  try {
    ({ asset } = await getAsset(wc.ctx, wc.user, wc.workspace.id, assetId));
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'forbidden')) notFound();
    throw error;
  }
  // Only uploaded videos are sources; a rendered clip or an image has no suggestions.
  if (asset.kind !== 'video' || asset.origin !== 'upload' || asset.status === 'deleted') notFound();
  const page = wc.pages.find((p) => p.id === asset.pageId);
  const role = wc.member.role;
  return (
    <>
      <div className="app-page-header">
        <div className="r-stack-sm" style={{ minWidth: 0 }}>
          <Link href={`/w/${slug}/find-clips?page=${asset.pageId}`} className="r-small back-link">
            <ArrowLeft aria-hidden width={16} height={16} /> Find clips
          </Link>
          <h1 className="page-title-wrap">{asset.originalFilename}</h1>
          <p className="r-row-tight">
            <span className="r-tabular">
              {formatDuration(asset.durationMs)}
              {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
              {page ? ` · ${page.name}` : ''}
            </span>
            {asset.isSample ? <SampleBadge /> : null}
          </p>
        </div>
      </div>
      {asset.status !== 'ready' || !asset.durationMs ? (
        <Banner tone="warning" title="This video is not ready">
          It is still being validated, or it was rejected. Suggestions and clips become available
          once it is ready.
        </Banner>
      ) : (
        <SourceWorkspace
          slug={slug}
          workspaceId={wc.workspace.id}
          source={{
            id: asset.id,
            originalFilename: asset.originalFilename,
            durationMs: asset.durationMs,
            hasAudio: asset.hasAudio,
          }}
          perms={{ create: can(role, 'content.create'), edit: can(role, 'content.edit') }}
          clipMaxMs={wc.ctx.config.media.clipMaxSeconds * 1000}
        />
      )}
    </>
  );
}
