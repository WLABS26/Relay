import { putPublishingRules } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; pageId: string };
/** Creates a new immutable policy revision (expectedRevision guards concurrent edits). */
export const PUT = api<P>({}, async (c) =>
  putPublishingRules(c.ctx, c.user, c.params.workspaceId, c.params.pageId, await c.body(), meta(c)),
);
