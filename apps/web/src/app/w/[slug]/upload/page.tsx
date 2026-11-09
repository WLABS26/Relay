import type { Metadata } from 'next';
import { Banner } from '@relay/ui';
import { UploadFlow } from '@/components/upload/UploadFlow';
import { loadWorkspace, selectedPage } from '@/lib/server/workspace';
import { FIRST_PARTY_STATEMENT } from '@relay/services';

export const metadata: Metadata = { title: 'Upload content' };

export default async function UploadPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const wc = await loadWorkspace(slug);
  const page = selectedPage(wc, sp.page) ?? wc.pages[0] ?? null;
  const uploadable = wc.pages.filter((p) => ['owner', 'admin', 'publisher', 'editor'].includes(wc.member.role) && p);
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Upload content</h1>
          <p>Upload a finished video, an image, or several images for a carousel. Files go straight to private storage and are validated before use.</p>
        </div>
      </div>
      {uploadable.length === 0 || wc.member.role === 'viewer' ? (
        <Banner tone="warning" title="You cannot upload here">Viewers have read-only access. Ask an admin for editor access.</Banner>
      ) : (
        <UploadFlow
          slug={slug}
          workspaceId={wc.workspace.id}
          statement={FIRST_PARTY_STATEMENT}
          limits={{ maxVideoBytes: wc.ctx.config.uploads.maxVideoBytes, maxImageBytes: wc.ctx.config.uploads.maxImageBytes, maxCarouselItems: wc.ctx.config.uploads.maxCarouselItems }}
          defaultPageId={page?.id ?? ''}
          pages={uploadable.map((p) => ({
            id: p.id,
            name: p.name,
            allowedFormats: p.allowedFormats,
            destinations: p.destinations.filter((d) => d.enabled).map((d) => ({ id: d.id, label: d.label, provider: d.provider, connectionMode: d.connectionMode, accountStatus: d.accountStatus })),
          }))}
        />
      )}
    </>
  );
}
