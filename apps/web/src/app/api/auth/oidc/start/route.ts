import { NextResponse, type NextRequest } from 'next/server';
import { isAppError } from '@relay/domain';
import { startOidcSignIn } from '@relay/services';
import { webContext } from '@/lib/server/context';

/** Begin OIDC sign-in: server-bound one-time state + PKCE, then redirect to the IdP. */
export async function GET(req: NextRequest) {
  const ctx = webContext();
  try {
    const { authorizationUrl, attemptId } = await startOidcSignIn(ctx, req.nextUrl.searchParams.get('returnTo'));
    const response = NextResponse.redirect(authorizationUrl, 302);
    response.cookies.set('relay_oidc_attempt', attemptId, { httpOnly: true, secure: ctx.config.session.secureCookies, sameSite: 'lax', path: '/api/auth/oidc', maxAge: 600 });
    return response;
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Single sign-on is unavailable.';
    return NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(message)}`, ctx.config.publicUrl), 302);
  }
}
