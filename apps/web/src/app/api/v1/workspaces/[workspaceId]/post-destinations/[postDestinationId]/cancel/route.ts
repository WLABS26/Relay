import { unscheduleDestination } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postDestinationId: string };
/** Cancel the unclaimed intent and release its reservation. */
export const POST = api<P>({}, async (c) => unscheduleDestination(c.ctx, c.user, c.params.workspaceId, c.params.postDestinationId, await c.body(), meta(c)));
