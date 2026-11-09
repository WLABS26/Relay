import { z } from 'zod';
import { DESTINATION_STATES } from '@relay/domain';
import { createPost, listPosts } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string };
export const GET = api<P>({}, async (c) => {
  const q = z.object({ pageId: z.uuid().optional(), state: z.enum(DESTINATION_STATES).optional() }).parse(c.query());
  const { posts } = await listPosts(c.ctx, c.user, c.params.workspaceId, q);
  return { posts };
});
/** Create a draft with destinations (Idempotency-Key supported). */
export const POST = api<P>({}, async (c) => {
  const result = await createPost(c.ctx, c.user, c.params.workspaceId, await c.body(), meta(c));
  return new ApiResponse(result.body, result.replayed ? 200 : 201);
});
