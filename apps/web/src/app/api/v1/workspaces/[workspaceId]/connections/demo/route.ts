import { createDemoConnection } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string };
/** Demo mode only: connect a simulated account. */
export const POST = api<P>(
  {},
  async (c) =>
    new ApiResponse(
      await createDemoConnection(c.ctx, c.user, c.params.workspaceId, await c.body(), meta(c)),
      201,
    ),
);
