import Link from 'next/link';
import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { ROLE_LABELS } from '@relay/domain';
import { Badge, Banner, Wordmark } from '@relay/ui';
import {
  PageSwitcher,
  SidebarFrame,
  SidebarNav,
  SignOutButton,
  ThemeToggle,
} from '@/components/shell/ShellClient';
import { loadWorkspace } from '@/lib/server/workspace';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const wc = await loadWorkspace(slug);
  const theme = (await cookies()).get('relay_theme')?.value;
  const demo = wc.ctx.config.demoMode;
  return (
    <div className="app-shell">
      <SidebarFrame>
        <Link
          href={`/w/${slug}/inbox`}
          className="app-brand r-brand-surface"
          style={{ textDecoration: 'none' }}
          aria-label="Relay home"
        >
          <Wordmark size={26} />
        </Link>
        <details className="switcher">
          <summary aria-label={`Workspace: ${wc.workspace.name}. Switch workspace`}>
            <span className="r-truncate" style={{ flex: 1 }}>
              {wc.workspace.name}
            </span>
            <ChevronDown aria-hidden width={16} height={16} />
          </summary>
          <div className="switcher-panel" role="list">
            {wc.workspaces.map((w) => (
              <a
                key={w.id}
                href={`/w/${w.slug}/inbox`}
                role="listitem"
                aria-current={w.slug === slug ? 'true' : undefined}
              >
                <span className="r-stack-sm" style={{ gap: 0 }}>
                  <span>{w.name}</span>
                  <span className="r-xs r-muted">
                    {ROLE_LABELS[w.role]}
                    {w.isDemo ? ' · demo' : ''}
                  </span>
                </span>
                {w.slug === slug ? <Check aria-hidden width={16} height={16} /> : null}
              </a>
            ))}
          </div>
        </details>
        <Suspense>
          <SidebarNav slug={slug} />
        </Suspense>
        <div className="app-sidebar-extra r-stack-sm" style={{ marginTop: 'auto' }}>
          <hr className="r-divider" />
          <div className="r-stack-sm" style={{ gap: 2, padding: '0 var(--space-3)' }}>
            <span className="r-small r-strong r-truncate">{wc.user.displayName}</span>
            <span className="r-xs r-muted r-truncate">
              {wc.user.email} · {ROLE_LABELS[wc.member.role]}
            </span>
          </div>
          <SignOutButton />
        </div>
      </SidebarFrame>
      <div className="app-main">
        <header className="app-topbar">
          <div className="r-row">
            <Suspense>
              <PageSwitcher
                pages={wc.pages.map((p) => ({
                  id: p.id,
                  name: p.name,
                  pausedAt: p.pausedAt ? p.pausedAt.toISOString() : null,
                }))}
              />
            </Suspense>
            {demo || wc.workspace.isDemo ? (
              <Badge tone="sim" title="Demo mode: simulated connections and sample data">
                Demo · simulated publishing
              </Badge>
            ) : null}
          </div>
          <div className="r-row-tight">
            <ThemeToggle current={theme === 'light' || theme === 'dark' ? theme : 'system'} />
          </div>
        </header>
        <main id="main" className="app-content" tabIndex={-1}>
          {wc.workspace.pausedAt ? (
            <Banner tone="warning" title="This workspace is paused">
              No new posts will be dispatched until an admin resumes it. Work already sent to a
              platform is still tracked.
            </Banner>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
