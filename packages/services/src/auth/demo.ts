import { withAuthBootstrap, withUser } from '@relay/db';
import { AppError } from '@relay/domain';
import type { ServiceContext } from '../context';
import { issueSession, type IssuedSession } from './sessions';

/**
 * Demo sign-in: pick one of the seeded demo users. It exists only when demo mode is on, which
 * the config validator forbids in production; this check repeats at runtime so a bypassed
 * validator still fails closed. Demo sessions also stop validating if demo mode is turned off.
 */

export function demoSignInAvailable(ctx: ServiceContext): boolean {
  return ctx.config.demoMode && !ctx.config.isProduction;
}

export interface DemoUser {
  email: string;
  displayName: string;
  summary: string;
}

export async function listDemoUsers(ctx: ServiceContext): Promise<DemoUser[]> {
  if (!demoSignInAvailable(ctx)) return [];
  const users = await withAuthBootstrap(ctx.db, (tx) =>
    tx.selectFrom('users').select(['id', 'email', 'displayName']).where('isDemo', '=', true).where('status', '=', 'active').execute(),
  );
  const rank: Record<string, number> = { owner: 0, admin: 1, publisher: 2, editor: 3, viewer: 4 };
  const withMemberships = await Promise.all(
    users.map(async (u) => {
      // Memberships are only visible in the user's own context (RLS), never in bootstrap.
      const ms = await withUser(ctx.db, u.id, (tx) =>
        tx
          .selectFrom('workspaceMemberships as m')
          .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
          .select(['m.role', 'w.name'])
          .where('m.userId', '=', u.id)
          .execute(),
      );
      const best = Math.min(...ms.map((m) => rank[m.role] ?? 9), 9);
      return {
        user: u,
        best,
        summary: ms.length > 0 ? ms.map((m) => `${m.role.charAt(0).toUpperCase()}${m.role.slice(1)} · ${m.name}`).join(', ') : 'No workspace yet',
      };
    }),
  );
  return withMemberships
    .sort((a, b) => a.best - b.best || a.user.displayName.localeCompare(b.user.displayName))
    .map(({ user, summary }) => ({ email: user.email, displayName: user.displayName, summary }));
}

export async function demoSignIn(ctx: ServiceContext, email: string, previousToken?: string | null): Promise<IssuedSession> {
  if (!demoSignInAvailable(ctx)) throw new AppError('demo_mode_disabled', 'Demo sign-in is not available.');
  const user = await withAuthBootstrap(ctx.db, (tx) =>
    tx
      .selectFrom('users')
      .select(['id'])
      .where('emailNormalized', '=', email.trim().toLowerCase())
      .where('isDemo', '=', true)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  );
  if (!user) throw new AppError('not_found', 'Demo user not found');
  return issueSession(ctx, { userId: user.id, method: 'demo', previousToken: previousToken ?? null });
}
