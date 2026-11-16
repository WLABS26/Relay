import type { Metadata } from 'next';
import Link from 'next/link';
import { Scissors, Upload } from 'lucide-react';
import { can } from '@relay/domain';
import { listClipSources } from '@relay/services';
import { EmptyState, linkButtonClass } from '@relay/ui';
import { SourceList } from '@/components/clips/SourceList';
import { toWire } from '@/components/clips/types';
import { loadWorkspace, selectedPage } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Find clips' };

export default async function FindClipsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const wc = await loadWorkspace(slug);
  const page = selectedPage(wc, sp.page);
  const { sources } = await listClipSources(wc.ctx, wc.user, wc.workspace.id, {
    ...(page ? { pageId: page.id } : {}),
  });
  const canUpload = can(wc.member.role, 'media.upload');
  const uploadHref = `/w/${slug}/upload?intent=clips${page ? `&page=${page.id}` : ''}`;
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Find clips</h1>
          <p>
            Relay analyses a video you uploaded, suggests the moments worth clipping and says why.
            You trim, frame and caption the clip, then hand it over as a draft post.
          </p>
        </div>
        {canUpload ? (
          <Link className={linkButtonClass('primary')} href={uploadHref}>
            <Upload aria-hidden /> Upload a video
          </Link>
        ) : null}
      </div>
      {sources.length === 0 ? (
        <EmptyState
          icon={<Scissors aria-hidden />}
          title={page ? `No videos on ${page.name} yet` : 'No videos yet'}
          action={
            canUpload ? (
              <Link className={linkButtonClass('secondary')} href={uploadHref}>
                Upload a video
              </Link>
            ) : undefined
          }
        >
          {canUpload
            ? 'Upload a recording you are allowed to use. Once it is validated, it appears here ready to analyse.'
            : 'Videos uploaded by an editor appear here once they are validated.'}
        </EmptyState>
      ) : (
        <>
          <p className="r-small r-muted">
            {page ? page.name : 'All pages'} · {sources.length} video
            {sources.length === 1 ? '' : 's'} ready to clip
          </p>
          <SourceList
            slug={slug}
            workspaceId={wc.workspace.id}
            sources={toWire(sources)}
            pageNames={Object.fromEntries(wc.pages.map((p) => [p.id, p.name]))}
            showPage={!page}
            canAnalyse={can(wc.member.role, 'content.create')}
          />
        </>
      )}
    </>
  );
}
