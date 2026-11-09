import { z } from 'zod';
import { demoSignIn } from '@relay/services';
import { api, ApiResponse } from '@/lib/server/api';
import { sessionCookies } from '@/lib/server/session';

/** Demo sign-in (demo mode only; 404 otherwise). Rotates any existing session. */
export const POST = api({ auth: false }, async (c) => {
  const { email } = z.object({ email: z.email() }).parse(await c.body());
  const previous = c.req.cookies.get(c.ctx.config.session.cookieName)?.value ?? null;
  const issued = await demoSignIn(c.ctx, email, previous);
  return new ApiResponse({ ok: true }, 200, sessionCookies(issued));
});
