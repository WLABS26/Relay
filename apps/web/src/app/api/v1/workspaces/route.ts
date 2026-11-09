import { createWorkspace, listMyWorkspaces } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';

export const GET = api({}, async (c) => ({ workspaces: await listMyWorkspaces(c.ctx, c.user) }));
export const POST = api(
  {},
  async (c) => new ApiResponse(await createWorkspace(c.ctx, c.user, await c.body(), meta(c)), 201),
);
