import { pauseSchema } from '@relay/domain';
import { setWorkspacePaused } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string };
export const POST = api<P>({}, async (c) => {
  const { reason } = pauseSchema.parse(await c.body());
  return setWorkspacePaused(c.ctx, c.user, c.params.workspaceId, true, reason, meta(c));
});
export const DELETE = api<P>({}, async (c) => setWorkspacePaused(c.ctx, c.user, c.params.workspaceId, false, undefined, meta(c)));
