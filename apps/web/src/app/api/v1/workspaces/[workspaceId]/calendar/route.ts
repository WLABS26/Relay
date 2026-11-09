import { getCalendar } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string };
/** Bounded date range in a page/workspace zone. */
export const GET = api<P>({}, async (c) =>
  getCalendar(c.ctx, c.user, c.params.workspaceId, c.query()),
);
