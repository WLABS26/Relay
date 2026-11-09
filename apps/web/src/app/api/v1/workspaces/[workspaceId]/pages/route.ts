import { createPage, listPages } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string };
export const GET = api<P>({}, async (c) => {
  const { pages } = await listPages(c.ctx, c.user, c.params.workspaceId);
  return { pages };
});
export const POST = api<P>({}, async (c) => new ApiResponse(await createPage(c.ctx, c.user, c.params.workspaceId, await c.body(), meta(c)), 201));
