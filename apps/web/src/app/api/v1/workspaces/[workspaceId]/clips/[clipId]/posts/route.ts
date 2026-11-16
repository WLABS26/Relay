import { createPostFromClip } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string; clipId: string };
/** Hand the rendered clip over to a new draft post (Idempotency-Key supported). */
export const POST = api<P>({}, async (c) => {
  const result = await createPostFromClip(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.clipId,
    await c.body(),
    meta(c),
  );
  return new ApiResponse(result.body, result.replayed ? 200 : 201);
});
