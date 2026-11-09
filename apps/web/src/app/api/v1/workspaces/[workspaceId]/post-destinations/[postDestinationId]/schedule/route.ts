import { scheduleDestination } from '@relay/services';
import { api, ApiResponse, meta } from '@/lib/server/api';
type P = { workspaceId: string; postDestinationId: string };
/** Reserve a slot and enqueue the durable publish workflow (Idempotency-Key supported). */
export const POST = api<P>({}, async (c) => {
  const result = await scheduleDestination(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.postDestinationId,
    await c.body(),
    meta(c),
  );
  return new ApiResponse(result.body, result.status);
});
