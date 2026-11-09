import type { Metadata } from 'next';
import Link from 'next/link';
import { can, PAGE_GOAL_LABELS, PROVIDER_LABELS, type DestinationProviderId, type PageGoal } from '@relay/domain';
import { listConnections } from '@relay/services';
import { Badge, Card, EmptyState, linkButtonClass, SampleBadge, SimulatedBadge } from '@relay/ui';
import { AddDestinationForm, CreatePageForm } from '@/components/settings/PageForms';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Pages & rules' };

export default async function PagesSettings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const wc = await loadWorkspace(slug);
  const manage = can(wc.member.role, 'pages.create');
  const connections = await listConnections(wc.ctx, wc.user, wc.workspace.id);
  const activeAccounts = connections.accounts.filter((a) => a.status === 'active' && a.provider !== 'twitch');
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Pages & rules</h1>
          <p>A page maps to one or more connected accounts and has its own goal, time zone and publishing rules.</p>
        </div>
      </div>
      {wc.pages.length === 0 ? <EmptyState title="No pages yet">Create a page to start planning content.</EmptyState> : null}
      <div className="r-stack">
        {wc.pages.map((p) => (
          <Card key={p.id} className="r-stack">
            <div className="r-spread">
              <div className="r-stack-sm" style={{ gap: 2 }}>
                <h2>{p.name}</h2>
                <span className="r-row-tight r-xs r-muted">
                  {p.timezone} · week starts {p.weekStart} · goal: {PAGE_GOAL_LABELS[p.goal as PageGoal]} · formats: {p.allowedFormats.join(', ')}
                  {p.isSample ? <SampleBadge /> : null}
                  {p.pausedAt ? <Badge tone="warning">Paused</Badge> : null}
                </span>
              </div>
              <Link className={linkButtonClass('secondary')} href={`/w/${slug}/p/${p.id}/publishing-rules`}>Publishing rules</Link>
            </div>
            <div className="r-stack-sm">
              <h3 className="r-section-title">Destinations</h3>
              {p.destinations.length === 0 ? <p className="r-small r-muted">No destinations yet.</p> : (
                <ul className="r-stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {p.destinations.map((d) => (
                    <li key={d.id} className="r-row-tight r-small">
                      <span className="r-strong">{d.label}</span>
                      <Badge>{PROVIDER_LABELS[d.provider as DestinationProviderId]}</Badge>
                      {d.connectionMode === 'simulated' ? <SimulatedBadge /> : null}
                      {d.accountStatus !== 'active' ? <Badge tone="warning">{d.accountStatus}</Badge> : null}
                      <span className="r-xs r-muted">default visibility {d.defaultVisibility}</span>
                    </li>
                  ))}
                </ul>
              )}
              {manage ? (
                <AddDestinationForm
                  workspaceId={wc.workspace.id}
                  pageId={p.id}
                  accounts={activeAccounts.filter((a) => !p.destinations.some((d) => d.socialAccountId === a.id)).map((a) => ({ id: a.id, label: `${PROVIDER_LABELS[a.provider as DestinationProviderId]} · ${a.displayName}${a.connectionMode === 'simulated' ? ' (simulated)' : ''}` }))}
                />
              ) : null}
            </div>
          </Card>
        ))}
      </div>
      {manage ? (
        <Card className="r-stack">
          <h2>Add a page</h2>
          <CreatePageForm workspaceId={wc.workspace.id} defaultTimezone={wc.workspace.timezone} />
        </Card>
      ) : null}
    </>
  );
}
