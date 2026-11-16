import { getClip, updateClip } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; clipId: string };
export const GET = api<P>({}, async (c) =>
  getClip(c.ctx, c.user, c.params.workspaceId, c.params.clipId),
);
/** New immutable revision with an optimistic version check. */
export const PATCH = api<P>({}, async (c) =>
  updateClip(c.ctx, c.user, c.params.workspaceId, c.params.clipId, await c.body(), meta(c)),
);
