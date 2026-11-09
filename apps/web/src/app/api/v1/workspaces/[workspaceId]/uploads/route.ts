import { startUpload } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string };
/** Reserve quota and start an upload (Idempotency-Key supported). */
export const POST = api<P>({}, async (c) => {
  const result = await startUpload(c.ctx, c.user, c.params.workspaceId, await c.body(), meta(c));
  return new ApiResponse(result.body, result.replayed ? 200 : 201);
});
