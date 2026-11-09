import { setSlotLock } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postDestinationId: string };
export const POST = api<P>({}, async (c) => setSlotLock(c.ctx, c.user, c.params.workspaceId, c.params.postDestinationId, await c.body(), meta(c)));
