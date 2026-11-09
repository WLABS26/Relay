import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, isAppError, isUuid, VISIBILITIES, type DestinationProviderId } from '@relay/domain';
import { SIMULATOR_FORMAT_PROFILES } from '@relay/providers';
import { getPostDetail } from '@relay/services';
import { PostWorkspace } from '@/components/posts/PostWorkspace';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Post' };

export default async function PostPage({ params }: { params: Promise<{ slug: string; postId: string }> }) {
  const { slug, postId } = await params;
  if (!isUuid(postId)) notFound();
  const wc = await loadWorkspace(slug);
  let detail;
  try {
    detail = await getPostDetail(wc.ctx, wc.user, wc.workspace.id, postId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const role = wc.member.role;
  const perms = {
    edit: can(role, 'content.edit'),
    submit: can(role, 'content.submit'),
    approve: can(role, 'content.approve'),
    schedule: can(role, 'content.schedule'),
    cancel: can(role, 'content.cancel'),
    retry: can(role, 'content.retry'),
    reconcile: can(role, 'content.reconcile'),
  };
  const { member: _member, ...data } = detail;
  const visibilityOptions = Object.fromEntries(
    data.destinations.map((d) => [
      d.id,
      d.account.connectionMode === 'simulated' ? [...SIMULATOR_FORMAT_PROFILES[d.account.provider as DestinationProviderId].visibilities] : [...VISIBILITIES],
    ]),
  );
  return <PostWorkspace slug={slug} workspaceId={wc.workspace.id} data={data} perms={perms} visibilityOptions={visibilityOptions} />;
}
