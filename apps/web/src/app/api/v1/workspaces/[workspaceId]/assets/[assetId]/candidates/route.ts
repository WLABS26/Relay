import { listCandidates } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string; assetId: string };
/** The newest analysis of an asset (status, envelope, summary) and its ranked candidates. */
export const GET = api<P>({}, async (c) => {
  const result = await listCandidates(c.ctx, c.user, c.params.workspaceId, c.params.assetId);
  const jobUrl = result.jobId
    ? `/api/v1/workspaces/${c.params.workspaceId}/jobs/${result.jobId}`
    : null;
  return { ...result, jobUrl };
});
