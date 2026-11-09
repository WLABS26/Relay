import { acceptInvitation } from '@relay/services';
import { api, meta } from '@/lib/server/api';

export const POST = api({}, async (c) => acceptInvitation(c.ctx, c.user, await c.body(), meta(c)));
