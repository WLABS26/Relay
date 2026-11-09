import { getPageDetail, updatePage } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; pageId: string };
export const GET = api<P>({}, async (c) => {
  const { member: _m, ...detail } = await getPageDetail(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.pageId,
  );
  return detail;
});
export const PATCH = api<P>({}, async (c) =>
  updatePage(c.ctx, c.user, c.params.workspaceId, c.params.pageId, await c.body(), meta(c)),
);
