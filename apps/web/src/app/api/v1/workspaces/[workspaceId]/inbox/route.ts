import { getInbox } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string };
export const GET = api<P>({}, async (c) => {
  const { member: _m, ...inbox } = await getInbox(c.ctx, c.user, c.params.workspaceId);
  return inbox;
});
