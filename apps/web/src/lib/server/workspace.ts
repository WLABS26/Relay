import { notFound } from 'next/navigation';
import { cache } from 'react';
import { isAppError } from '@relay/domain';
import {
  getWorkspace,
  listMyWorkspaces,
  listPages,
  resolveWorkspaceSlug,
} from '@relay/services';
import { webContext } from './context';
import { requireSession } from './session';

/**
 * Per-request workspace context for pages. The slug is only a locator: membership is
 * re-verified in the tenant transaction, and non-members get a 404.
 */
export const loadWorkspace = cache(async (slug: string) => {
  const session = await requireSession();
  const ctx = webContext();
  try {
    const workspaceId = await resolveWorkspaceSlug(ctx, session.user, slug);
    const [{ workspace, member }, { pages }, workspaces] = await Promise.all([
      getWorkspace(ctx, session.user, workspaceId),
      listPages(ctx, session.user, workspaceId),
      listMyWorkspaces(ctx, session.user),
    ]);
    return { session, ctx, user: session.user, workspace, member, pages, workspaces };
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
});

export type WorkspaceContext = Awaited<ReturnType<typeof loadWorkspace>>;

/** Resolve the page filter from ?page=, ignoring pages the member cannot see. */
export function selectedPage(wc: WorkspaceContext, pageId: string | undefined) {
  return pageId ? (wc.pages.find((p) => p.id === pageId) ?? null) : null;
}
