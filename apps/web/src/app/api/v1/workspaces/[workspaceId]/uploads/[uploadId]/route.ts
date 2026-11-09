import { abortUpload } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; uploadId: string };
export const DELETE = api<P>({}, async (c) =>
  abortUpload(c.ctx, c.user, c.params.workspaceId, c.params.uploadId, meta(c)),
);
