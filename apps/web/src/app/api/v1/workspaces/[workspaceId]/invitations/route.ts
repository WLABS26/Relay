import { inviteMember } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string };
export const POST = api<P>({}, async (c) => new ApiResponse(await inviteMember(c.ctx, c.user, c.params.workspaceId, await c.body(), meta(c)), 201));
