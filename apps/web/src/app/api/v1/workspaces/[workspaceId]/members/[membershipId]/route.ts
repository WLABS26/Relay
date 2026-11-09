import { removeMember, updateMember } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; membershipId: string };
export const PATCH = api<P>({}, async (c) =>
  updateMember(c.ctx, c.user, c.params.workspaceId, c.params.membershipId, await c.body(), meta(c)),
);
export const DELETE = api<P>({}, async (c) =>
  removeMember(c.ctx, c.user, c.params.workspaceId, c.params.membershipId, meta(c)),
);
