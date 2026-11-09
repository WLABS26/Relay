import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Banner, linkButtonClass, Wordmark } from '@relay/ui';
import { demoSignInAvailable, listDemoUsers, safeReturnTo } from '@relay/services';
import { webContext } from '@/lib/server/context';
import { getSession } from '@/lib/server/session';
import { DemoSignIn } from '@/components/auth/DemoSignIn';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (await getSession()) redirect(returnTo);
  const ctx = webContext();
  const demoUsers = await listDemoUsers(ctx);
  return (
    <div className="auth-layout">
      <section className="auth-brand r-brand-surface" aria-label="About Relay">
        <Wordmark size={32} />
        <div className="r-stack" style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: 'var(--text-2xl)' }}>Plan, approve and publish with evidence.</h1>
          <p className="r-secondary">
            Upload finished content, schedule it into each page’s calendar with explicit approvals, and publish through connected accounts. Every step is recorded.
          </p>
        </div>
        <p className="r-xs r-muted">Relay Design System v1.1 · Neutral Edition (stand-in marks — kit not supplied)</p>
      </section>
      <main id="main" className="auth-panel">
        <div className="r-stack-sm">
          <h2 style={{ fontSize: 'var(--text-xl)' }}>Sign in</h2>
          <p className="r-muted r-small">Signing in to Relay is separate from connecting social accounts.</p>
        </div>
        {params.error ? <Banner tone="danger" title="Sign-in failed">{params.error}</Banner> : null}
        {ctx.config.oidc ? (
          <a className={linkButtonClass('primary', 'r-button--block')} href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`}>
            Continue with single sign-on
          </a>
        ) : null}
        {demoSignInAvailable(ctx) ? (
          <DemoSignIn users={demoUsers} returnTo={returnTo} />
        ) : !ctx.config.oidc ? (
          <Banner tone="warning" title="No sign-in method is configured">
            Configure OIDC (RELAY_OIDC_*) or enable demo mode for local development.
          </Banner>
        ) : null}
      </main>
    </div>
  );
}
