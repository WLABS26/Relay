import { revokeSession } from '@relay/services';
import { api, ApiResponse } from '@/lib/server/api';
import { clearedSessionCookies } from '@/lib/server/session';

export const POST = api({ auth: false }, async (c) => {
  if (c.session) await revokeSession(c.ctx, c.session);
  return new ApiResponse({ ok: true }, 200, clearedSessionCookies());
});
