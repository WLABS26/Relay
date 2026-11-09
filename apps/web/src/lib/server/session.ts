import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import {
  csrfTokenFor,
  validateSession,
  type IssuedSession,
  type SessionInfo,
} from '@relay/services';
import { webContext } from './context';

/** The current session for this request (deduplicated per render). */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const ctx = webContext();
  const store = await cookies();
  return validateSession(ctx, store.get(ctx.config.session.cookieName)?.value);
});

/** Require a signed-in user or redirect to sign-in, preserving the current path. */
export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) {
    const h = await headers();
    const path = h.get('x-relay-path') ?? '/';
    redirect(`/sign-in?returnTo=${encodeURIComponent(path)}`);
  }
  return session;
}

export interface CookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict';
  path: '/';
  maxAge: number;
}

/** Session + CSRF cookies for a newly issued session. */
export function sessionCookies(issued: IssuedSession): CookieSpec[] {
  const { session } = webContext().config;
  const maxAge = Math.max(0, Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000));
  return [
    {
      name: session.cookieName,
      value: issued.token,
      httpOnly: true,
      secure: session.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge,
    },
    // Readable by the page's own JavaScript (sent back as X-CSRF-Token); SameSite=Strict.
    {
      name: session.csrfCookieName,
      value: issued.csrfToken,
      httpOnly: false,
      secure: session.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge,
    },
  ];
}

export function clearedSessionCookies(): CookieSpec[] {
  const { session } = webContext().config;
  return [
    {
      name: session.cookieName,
      value: '',
      httpOnly: true,
      secure: session.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    },
    {
      name: session.csrfCookieName,
      value: '',
      httpOnly: false,
      secure: session.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    },
  ];
}

export function csrfForSession(session: SessionInfo): string {
  return csrfTokenFor(webContext().config.session.secret, session.sessionId);
}
