import { exportClip } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; clipId: string };
/** Short-lived download link for the rendered clip; needs the export right and is audited. */
export const POST = api<P>({}, async (c) =>
  exportClip(c.ctx, c.user, c.params.workspaceId, c.params.clipId, meta(c)),
);
