import { NextResponse, type NextRequest } from 'next/server';
import { isAppError } from '@relay/domain';
import { completeOidcSignIn, safeError } from '@relay/services';
import { webContext } from '@/lib/server/context';
import { sessionCookies } from '@/lib/server/session';

/** OIDC callback: consume the one-time attempt bound to this browser, then issue a session. */
export async function GET(req: NextRequest) {
  const ctx = webContext();
  const callbackUrl = new URL(req.nextUrl.pathname + req.nextUrl.search, ctx.config.publicUrl);
  try {
    const { session, returnTo } = await completeOidcSignIn(ctx, {
      callbackUrl,
      attemptId: req.cookies.get('relay_oidc_attempt')?.value ?? null,
      previousToken: req.cookies.get(ctx.config.session.cookieName)?.value ?? null,
    });
    const response = NextResponse.redirect(new URL(returnTo, ctx.config.publicUrl), 302);
    for (const c of sessionCookies(session)) response.cookies.set(c.name, c.value, { httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, path: c.path, maxAge: c.maxAge });
    response.cookies.set('relay_oidc_attempt', '', { path: '/api/auth/oidc', maxAge: 0 });
    return response;
  } catch (error) {
    ctx.logger.warn({ err: safeError(error) }, 'oidc callback failed');
    const message = isAppError(error) ? error.message : 'Sign-in failed. Please try again.';
    return NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(message)}`, ctx.config.publicUrl), 302);
  }
}
