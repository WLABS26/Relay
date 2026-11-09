import { retryDestination } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postDestinationId: string };
/** Resume a failed destination from its last verified checkpoint. */
export const POST = api<P>({}, async (c) => retryDestination(c.ctx, c.user, c.params.workspaceId, c.params.postDestinationId, await c.body(), meta(c)));
