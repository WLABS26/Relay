import { getPostDetail, updatePost } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postId: string };
export const GET = api<P>({}, async (c) => {
  const { member: _m, ...detail } = await getPostDetail(c.ctx, c.user, c.params.workspaceId, c.params.postId);
  return detail;
});
/** New immutable revision with an optimistic version check. */
export const PATCH = api<P>({}, async (c) => updatePost(c.ctx, c.user, c.params.workspaceId, c.params.postId, await c.body(), meta(c)));
