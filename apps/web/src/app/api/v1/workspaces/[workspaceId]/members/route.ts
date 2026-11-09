import { listMembers } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string };
export const GET = api<P>({}, async (c) => {
  const { member: _m, ...data } = await listMembers(c.ctx, c.user, c.params.workspaceId);
  return data;
});
