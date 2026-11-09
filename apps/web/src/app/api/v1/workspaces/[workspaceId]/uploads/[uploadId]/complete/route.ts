import { completeUpload } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string; uploadId: string };
/** Verify parts and size with storage, quarantine, enqueue validation. 202 + job link. */
export const POST = api<P>({}, async (c) => {
  const result = await completeUpload(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.uploadId,
    await c.body(),
    meta(c),
  );
  const jobUrl = result.jobId
    ? `/api/v1/workspaces/${c.params.workspaceId}/jobs/${result.jobId}`
    : null;
  return new ApiResponse({ ...result, jobUrl }, 202);
});
