import { z } from 'zod';
import { mediaUrl } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string; assetId: string };
/** Short-lived signed URL for one exact object version, minted after authorisation. */
export const GET = api<P>({}, async (c) => {
  const { variant } = z
    .object({ variant: z.enum(['thumbnail', 'proxy', 'original']).default('thumbnail') })
    .parse(c.query());
  return mediaUrl(c.ctx, c.user, c.params.workspaceId, c.params.assetId, variant);
});
