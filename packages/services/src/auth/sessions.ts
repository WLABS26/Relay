import { withAuthBootstrap, withUser } from '@relay/db';
import { hmacSha256, randomToken, safeEqual, sha256Bytes } from '@relay/domain/server';
import type { AuthenticatedUser } from '../access';
import type { ServiceContext } from '../context';

/**
 * Server-side sessions. The cookie holds a 256-bit random token; the database stores only its
 * SHA-256 hash, so a database leak does not yield usable sessions. Sessions have an absolute
 * lifetime and a sliding idle timeout, and are rotated on every sign-in (the previous session
 * from the same browser is revoked — session fixation defence).
 */

export interface SessionInfo {
  sessionId: string;
  user: AuthenticatedUser;
  authMethod: 'demo' | 'oidc';
  expiresAt: Date;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
  csrfToken: string;
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function csrfTokenFor(secret: string, sessionId: string): string {
  return hmacSha256(secret, `csrf:v1:${sessionId}`).toString('base64url');
}

export function verifyCsrfToken(secret: string, sessionId: string, presented: string | null | undefined): boolean {
  if (!presented || presented.length > 200) return false;
  return safeEqual(csrfTokenFor(secret, sessionId), presented);
}

export async function issueSession(
  ctx: ServiceContext,
  input: { userId: string; method: 'demo' | 'oidc'; previousToken?: string | null },
): Promise<IssuedSession> {
  const now = ctx.clock.now();
  const token = randomToken(32);
  const sessionId = ctx.ids.next();
  const expiresAt = new Date(now.getTime() + ctx.config.session.absoluteTtlSeconds * 1000);
  const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), now.getTime() + ctx.config.session.idleTtlSeconds * 1000));
  await withAuthBootstrap(ctx.db, async (tx) => {
    if (input.previousToken) {
      await tx
        .updateTable('sessions')
        .set({ revokedAt: now, revokedReason: 'rotated' })
        .where('tokenHash', '=', sha256Bytes(input.previousToken))
        .where('revokedAt', 'is', null)
        .execute();
    }
    await tx
      .insertInto('sessions')
      .values({
        id: sessionId,
        userId: input.userId,
        tokenHash: sha256Bytes(token),
        authMethod: input.method,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        idleExpiresAt,
      })
      .execute();
    await tx.updateTable('users').set({ lastSignInAt: now }).where('id', '=', input.userId).execute();
  });
  return { token, sessionId, expiresAt, csrfToken: csrfTokenFor(ctx.config.session.secret, sessionId) };
}

/** Resolve a session token to its active user, sliding the idle timeout. */
export async function validateSession(ctx: ServiceContext, token: string | null | undefined): Promise<SessionInfo | null> {
  if (!token || token.length < 32 || token.length > 100) return null;
  const now = ctx.clock.now();
  return withAuthBootstrap(ctx.db, async (tx) => {
    const row = await tx
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.userId')
      .select([
        's.id as sessionId',
        's.authMethod',
        's.expiresAt',
        's.idleExpiresAt',
        's.lastSeenAt',
        'u.id as userId',
        'u.email',
        'u.displayName',
        'u.isDemo',
        'u.status',
      ])
      .where('s.tokenHash', '=', sha256Bytes(token))
      .where('s.revokedAt', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    if (row.status !== 'active' || row.expiresAt <= now || row.idleExpiresAt <= now) return null;
    // Demo users can only sign in while demo mode is on.
    if ((row.authMethod === 'demo' || row.isDemo) && !ctx.config.demoMode) return null;
    if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idle = new Date(Math.min(row.expiresAt.getTime(), now.getTime() + ctx.config.session.idleTtlSeconds * 1000));
      await tx.updateTable('sessions').set({ lastSeenAt: now, idleExpiresAt: idle }).where('id', '=', row.sessionId).execute();
    }
    return {
      sessionId: row.sessionId,
      authMethod: row.authMethod as 'demo' | 'oidc',
      expiresAt: row.expiresAt,
      user: { userId: row.userId, email: row.email, displayName: row.displayName, isDemo: row.isDemo },
    };
  });
}

export async function revokeSession(ctx: ServiceContext, session: SessionInfo, reason: 'sign_out' | 'admin' = 'sign_out'): Promise<void> {
  await withUser(ctx.db, session.user.userId, async (tx) => {
    await tx
      .updateTable('sessions')
      .set({ revokedAt: ctx.clock.now(), revokedReason: reason })
      .where('id', '=', session.sessionId)
      .where('revokedAt', 'is', null)
      .execute();
  });
}
