import { revokeInvitation } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; invitationId: string };
export const DELETE = api<P>({}, async (c) => revokeInvitation(c.ctx, c.user, c.params.workspaceId, c.params.invitationId, meta(c)));
