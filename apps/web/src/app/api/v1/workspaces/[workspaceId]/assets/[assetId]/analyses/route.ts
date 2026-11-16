import { startAnalysis } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string; assetId: string };
/**
 * Ask for a highlight analysis of a ready video. 202 + job link for a new analysis, 200 with
 * the existing one when it is queued, running or finished for the current versions.
 */
export const POST = api<P>({}, async (c) => {
  const body = await c.body();
  // The asset comes from the path; anything else in the body is refused by the strict schema.
  const input = { ...(typeof body === 'object' ? body : { body }), assetId: c.params.assetId };
  const result = await startAnalysis(c.ctx, c.user, c.params.workspaceId, input, meta(c));
  const jobUrl = result.body.jobId
    ? `/api/v1/workspaces/${c.params.workspaceId}/jobs/${result.body.jobId}`
    : null;
  return new ApiResponse({ ...result.body, jobUrl }, result.status);
});
