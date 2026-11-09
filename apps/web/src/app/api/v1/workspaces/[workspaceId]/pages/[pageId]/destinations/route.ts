import { addPageDestination } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string; pageId: string };
export const POST = api<P>({}, async (c) => new ApiResponse(await addPageDestination(c.ctx, c.user, c.params.workspaceId, c.params.pageId, await c.body(), meta(c)), 201));
