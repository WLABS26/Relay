import { getResults } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string };
export const GET = api<P>({}, async (c) => {
  const { member: _m, ...results } = await getResults(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.query(),
  );
  return results;
});
