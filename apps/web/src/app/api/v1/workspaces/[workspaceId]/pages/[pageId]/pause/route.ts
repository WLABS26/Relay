import { pauseSchema } from '@relay/domain';
import { setPagePaused } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; pageId: string };
/** Pause: bump generation, stop new dispatch claims, report in-flight work. */
export const POST = api<P>({}, async (c) => {
  const { reason } = pauseSchema.parse(await c.body());
  return setPagePaused(c.ctx, c.user, c.params.workspaceId, c.params.pageId, true, reason, meta(c));
});
/** Resume. */
export const DELETE = api<P>({}, async (c) => setPagePaused(c.ctx, c.user, c.params.workspaceId, c.params.pageId, false, undefined, meta(c)));
