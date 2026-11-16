import { createClip, listClips } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string };
/** Clips the member may see, newest first (?pageId=, ?sourceAssetId=). */
export const GET = api<P>({}, async (c) =>
  listClips(c.ctx, c.user, c.params.workspaceId, c.query()),
);
/** Start a clip from a candidate or an explicit range (Idempotency-Key supported). */
export const POST = api<P>({}, async (c) => {
  const result = await createClip(c.ctx, c.user, c.params.workspaceId, await c.body(), meta(c));
  return new ApiResponse(result.body, result.replayed ? 200 : 201);
});
