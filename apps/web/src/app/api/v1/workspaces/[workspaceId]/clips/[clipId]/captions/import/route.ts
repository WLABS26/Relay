import { importCaptions } from '@relay/services';
import { api } from '@/lib/server/api';
type P = { workspaceId: string; clipId: string };
/** Parse and validate SRT or WebVTT text into cues for the editor. Nothing is stored. */
export const POST = api<P>({}, async (c) =>
  importCaptions(c.ctx, c.user, c.params.workspaceId, c.params.clipId, await c.body()),
);
