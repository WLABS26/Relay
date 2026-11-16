import { setCandidateFeedback } from '@relay/services';
import { api, meta } from '@/lib/server/api';
type P = { workspaceId: string; candidateId: string };
/** Record a reviewer's verdict on a suggested clip. */
export const POST = api<P>({}, async (c) =>
  setCandidateFeedback(
    c.ctx,
    c.user,
    c.params.workspaceId,
    c.params.candidateId,
    await c.body(),
    meta(c),
  ),
);
