import { submitPost } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postId: string };
export const POST = api<P>({}, async (c) =>
  submitPost(c.ctx, c.user, c.params.workspaceId, c.params.postId, await c.body(), meta(c)),
);
