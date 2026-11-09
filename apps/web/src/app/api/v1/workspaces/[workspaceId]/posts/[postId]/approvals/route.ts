import { decideApprovals } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; postId: string };
/** Approve/reject exact revision + intent hash per destination; per-item outcomes. */
export const POST = api<P>({}, async (c) => decideApprovals(c.ctx, c.user, c.params.workspaceId, c.params.postId, await c.body(), meta(c)));
