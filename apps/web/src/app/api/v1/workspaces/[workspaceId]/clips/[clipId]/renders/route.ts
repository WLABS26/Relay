import { requestClipRender } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string; clipId: string };
/**
 * Render a clip revision into a derived asset (Idempotency-Key supported). 202 + job link for
 * a new render, 200 when an identical edit is already queued, running or rendered.
 */
export const POST = api<P>({}, async (c) => {
  const result = await requestClipRender(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.clipId,
    await c.body(),
    meta(c),
  );
  const jobUrl = result.body.jobId
    ? `/api/v1/workspaces/${c.params.workspaceId}/jobs/${result.body.jobId}`
    : null;
  return new ApiResponse({ ...result.body, jobUrl }, result.replayed ? 200 : result.status);
});
