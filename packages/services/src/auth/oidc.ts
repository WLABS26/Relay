import * as oidc from 'openid-client';
import { withAuthBootstrap } from '@relay/db';
import { AppError } from '@relay/domain';
import { sha256Bytes } from '@relay/domain/server';
import { secretAad } from '../crypto/envelope';
import type { ServiceContext } from '../context';
import { issueSession, type IssuedSession } from './sessions';

/**
 * Application sign-in with OpenID Connect (authorization code + PKCE S256, one-time state
 * bound to the browser through a short-lived attempt cookie, nonce-checked ID token). This is
 * distinct from linking social accounts, which happens per provider with its own OAuth
 * attempts and scopes (M3+).
 */

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
let discovered: { key: string; config: oidc.Configuration } | null = null;

async function configuration(ctx: ServiceContext): Promise<oidc.Configuration> {
  const settings = ctx.config.oidc;
  if (!settings) throw new AppError('not_found', 'Single sign-on is not configured.');
  const key = `${settings.issuer}|${settings.clientId}`;
  if (discovered?.key === key) return discovered.config;
  const config = await oidc.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret, undefined, {
    timeout: 10,
  });
  discovered = { key, config };
  return config;
}

/** Only same-origin relative paths are allowed as post-sign-in destinations. */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.length > 500) return '/';
  try {
    const u = new URL(raw, 'http://relay.invalid');
    return u.host === 'relay.invalid' ? `${u.pathname}${u.search}` : '/';
  } catch {
    return '/';
  }
}

export async function startOidcSignIn(
  ctx: ServiceContext,
  returnTo: string | null,
): Promise<{ authorizationUrl: string; attemptId: string; expiresAt: Date }> {
  const settings = ctx.config.oidc;
  if (!settings) throw new AppError('not_found', 'Single sign-on is not configured.');
  const config = await configuration(ctx);
  const attemptId = ctx.ids.next();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
  const sealedVerifier = await ctx.encryptor.encrypt(verifier, secretAad({ purpose: 'oidc_login', id: attemptId }));
  await withAuthBootstrap(ctx.db, (tx) =>
    tx
      .insertInto('authLoginAttempts')
      .values({
        id: attemptId,
        stateHash: sha256Bytes(state),
        nonce,
        codeVerifierCiphertext: sealedVerifier,
        returnTo: safeReturnTo(returnTo),
        createdAt: now,
        expiresAt,
      })
      .execute(),
  );
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: settings.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { authorizationUrl: url.toString(), attemptId, expiresAt };
}

export async function completeOidcSignIn(
  ctx: ServiceContext,
  input: { callbackUrl: URL; attemptId: string | null; previousToken?: string | null },
): Promise<{ session: IssuedSession; returnTo: string }> {
  const settings = ctx.config.oidc;
  if (!settings) throw new AppError('not_found', 'Single sign-on is not configured.');
  const state = input.callbackUrl.searchParams.get('state');
  if (!state || !input.attemptId) throw new AppError('unauthenticated', 'Sign-in attempt is missing or expired. Please try again.');
  const now = ctx.clock.now();

  // Consume the attempt exactly once; it must belong to this browser (cookie) and this state.
  const attempt = await withAuthBootstrap(ctx.db, (tx) =>
    tx
      .updateTable('authLoginAttempts')
      .set({ consumedAt: now })
      .where('id', '=', input.attemptId!)
      .where('stateHash', '=', sha256Bytes(state))
      .where('consumedAt', 'is', null)
      .where('expiresAt', '>', now)
      .returning(['id', 'nonce', 'codeVerifierCiphertext', 'returnTo'])
      .executeTakeFirst(),
  );
  if (!attempt) throw new AppError('unauthenticated', 'Sign-in attempt is invalid, already used or expired. Please try again.');

  const verifier = (
    await ctx.encryptor.decrypt(attempt.codeVerifierCiphertext, secretAad({ purpose: 'oidc_login', id: attempt.id }))
  ).toString('utf8');
  const config = await configuration(ctx);
  // The callback must arrive on the exact registered redirect URI.
  const callback = new URL(input.callbackUrl.toString());
  const registered = new URL(settings.redirectUri);
  if (callback.origin !== registered.origin || callback.pathname !== registered.pathname) {
    throw new AppError('unauthenticated', 'Unexpected sign-in callback location.');
  }
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: attempt.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new AppError('unauthenticated', 'The identity provider did not return a subject.');
  const email = typeof claims.email === 'string' ? claims.email.trim() : null;
  if (!email || claims.email_verified === false) {
    throw new AppError('unauthenticated', 'A verified email address is required to sign in.');
  }
  const emailNormalized = email.toLowerCase();
  const domain = emailNormalized.split('@')[1] ?? '';
  const issuer = String(claims.iss);
  const displayName = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : email;

  const userId = await withAuthBootstrap(ctx.db, async (tx) => {
    const identity = await tx
      .selectFrom('userIdentities')
      .select(['userId'])
      .where('issuer', '=', issuer)
      .where('subject', '=', claims.sub)
      .executeTakeFirst();
    if (identity) {
      await tx.updateTable('userIdentities').set({ lastUsedAt: now }).where('issuer', '=', issuer).where('subject', '=', claims.sub).execute();
      return identity.userId;
    }
    const existing = await tx
      .selectFrom('users')
      .select(['id', 'isDemo', 'status'])
      .where('emailNormalized', '=', emailNormalized)
      .executeTakeFirst();
    if (existing?.isDemo) throw new AppError('unauthenticated', 'This email belongs to a demo account.');
    if (existing && existing.status !== 'active') throw new AppError('unauthenticated', 'This account is disabled.');
    let id = existing?.id;
    if (!id) {
      if (settings.allowedEmailDomains.length > 0 && !settings.allowedEmailDomains.includes(domain)) {
        throw new AppError('unauthenticated', 'Your email domain is not allowed to create a Relay account.');
      }
      id = ctx.ids.next();
      await tx.insertInto('users').values({ id, email, emailNormalized, displayName }).execute();
    }
    await tx.insertInto('userIdentities').values({ id: ctx.ids.next(), userId: id, issuer, subject: claims.sub, lastUsedAt: now }).execute();
    return id;
  });

  const session = await issueSession(ctx, { userId, method: 'oidc', previousToken: input.previousToken ?? null });
  return { session, returnTo: attempt.returnTo };
}
