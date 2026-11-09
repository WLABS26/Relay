import { resolveReconciliation } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postDestinationId: string };
/** Owner/admin resolution of an unknown outcome: link a verified external ID or close. */
export const POST = api<P>({}, async (c) =>
  resolveReconciliation(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.postDestinationId,
    await c.body(),
    meta(c),
  ),
);
