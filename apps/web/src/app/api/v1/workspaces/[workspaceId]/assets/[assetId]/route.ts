import { getAsset } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string; assetId: string };
export const GET = api<P>({}, async (c) =>
  getAsset(c.ctx, c.user, c.params.workspaceId, c.params.assetId),
);
