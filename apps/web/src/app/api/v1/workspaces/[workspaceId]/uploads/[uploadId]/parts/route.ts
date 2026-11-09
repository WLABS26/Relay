import { signUploadParts } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string; uploadId: string };
/** Sign an allowed range of server-planned part numbers. */
export const POST = api<P>({}, async (c) => signUploadParts(c.ctx, c.user, c.params.workspaceId, c.params.uploadId, await c.body()));
