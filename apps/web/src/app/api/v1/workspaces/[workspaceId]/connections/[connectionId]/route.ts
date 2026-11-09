import { disconnectAccount } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; connectionId: string };
/** Disconnect and hold affected work (in-flight work is reported, not hidden). */
export const DELETE = api<P>({}, async (c) => disconnectAccount(c.ctx, c.user, c.params.workspaceId, c.params.connectionId, meta(c)));
