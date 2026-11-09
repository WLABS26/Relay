import { z } from 'zod';
import { listAssets } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string };
export const GET = api<P>({}, async (c) => {
  const { pageId } = z.object({ pageId: z.uuid() }).parse(c.query());
  return listAssets(c.ctx, c.user, c.params.workspaceId, pageId);
});
