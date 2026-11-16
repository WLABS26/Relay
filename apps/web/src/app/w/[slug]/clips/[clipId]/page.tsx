import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, isAppError, isUuid } from '@relay/domain';
import { getClip } from '@relay/services';
import { ClipEditor } from '@/components/clips/ClipEditor';
import { toWire } from '@/components/clips/types';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Edit clip' };

export default async function ClipPage({
  params,
}: {
  params: Promise<{ slug: string; clipId: string }>;
}) {
  const { slug, clipId } = await params;
  if (!isUuid(clipId)) notFound();
  const wc = await loadWorkspace(slug);
  let detail;
  try {
    detail = await getClip(wc.ctx, wc.user, wc.workspace.id, clipId);
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'forbidden')) notFound();
    throw error;
  }
  const role = wc.member.role;
  // The clip's page comes from the shell loader, so the hand-off can name its destinations
  // (and label simulated ones) without another query.
  const page = wc.pages.find((p) => p.id === detail.clip.pageId);
  return (
    <ClipEditor
      slug={slug}
      workspaceId={wc.workspace.id}
      initial={toWire(detail)}
      pageName={page?.name ?? null}
      perms={{
        edit: can(role, 'content.edit'),
        create: can(role, 'content.create'),
        export: can(role, 'content.export'),
      }}
      clipMaxMs={wc.ctx.config.media.clipMaxSeconds * 1000}
      destinations={(page?.destinations ?? [])
        .filter((d) => d.enabled)
        .map((d) => ({
          id: d.id,
          label: d.label,
          provider: d.provider,
          simulated: d.connectionMode === 'simulated',
          active: d.accountStatus === 'active',
        }))}
    />
  );
}
