import { recommendSlotsFor } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string };
/** Propose time slots. Never writes to the calendar. */
export const POST = api<P>({}, async (c) =>
  recommendSlotsFor(c.ctx, c.user, c.params.workspaceId, await c.body()),
);
