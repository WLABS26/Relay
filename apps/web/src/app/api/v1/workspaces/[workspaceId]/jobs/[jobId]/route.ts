import { getJobRun } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string; jobId: string };
export const GET = api<P>({}, async (c) =>
  getJobRun(c.ctx, c.user, c.params.workspaceId, c.params.jobId),
);
