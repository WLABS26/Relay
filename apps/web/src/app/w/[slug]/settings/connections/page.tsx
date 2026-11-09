import type { Metadata } from 'next';
import {
  can,
  PROVIDER_LABELS,
  type CapabilityKey,
  type DestinationProviderId,
} from '@relay/domain';
import { listConnections } from '@relay/services';
import { Badge, Banner, Card, EmptyState, SimulatedBadge } from '@relay/ui';
import { DemoConnectionForm, DisconnectButton } from '@/components/settings/ConnectionForms';
import { formatDateTime } from '@/lib/format';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Connections' };

const CAP_LABELS: Record<CapabilityKey, string> = {
  'publish.video': 'Publish video',
  'publish.image': 'Publish image',
  'publish.carousel': 'Publish carousel',
  'metrics.read': 'Read metrics',
  'export.manual': 'Manual export',
};

export default async function ConnectionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const wc = await loadWorkspace(slug);
  const data = await listConnections(wc.ctx, wc.user, wc.workspace.id);
  const manage = can(wc.member.role, 'connections.manage');
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Connections</h1>
          <p>
            Connected platform accounts and what each can do right now. Linking an account is
            separate from signing in to Relay.
          </p>
        </div>
      </div>
      {data.demoMode ? (
        <Banner tone="info" title="Demo mode: simulated connections">
          Simulated accounts are driven by Relay’s deterministic provider simulator. They
          demonstrate workflow behaviour only — nothing is sent to a real platform, and they stop
          working when demo mode is off.
        </Banner>
      ) : null}
      {data.accounts.length === 0 ? (
        <EmptyState title="No connected accounts">
          Connect an account to publish from Relay.
        </EmptyState>
      ) : null}
      <div className="r-stack">
        {data.accounts.map((a) => (
          <Card key={a.id} className="r-stack">
            <div className="r-spread">
              <div className="r-stack-sm" style={{ gap: 2 }}>
                <h2 className="r-row-tight">
                  {a.displayName}{' '}
                  {a.connectionMode === 'simulated' ? (
                    <SimulatedBadge />
                  ) : (
                    <Badge tone="info">Live</Badge>
                  )}
                </h2>
                <span className="r-xs r-muted">
                  {PROVIDER_LABELS[a.provider as DestinationProviderId] ?? a.provider} ·{' '}
                  {a.accountType} · {a.handle}
                  {a.simulatorProfile
                    ? ` · simulator profile: ${a.simulatorProfile.replace(/_/g, ' ')}`
                    : ''}
                </span>
              </div>
              <div className="r-row-tight">
                <Badge tone={a.status === 'active' ? 'success' : 'warning'}>
                  {a.status === 'active' ? 'Healthy' : a.status}
                </Badge>
                {manage && a.status === 'active' ? (
                  <DisconnectButton
                    workspaceId={wc.workspace.id}
                    accountId={a.id}
                    name={a.displayName}
                  />
                ) : null}
              </div>
            </div>
            <div className="r-table-wrap">
              <table className="r-table">
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">State</th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(a.capabilities) as CapabilityKey[]).map((key) => {
                    const cap = a.capabilities[key];
                    return (
                      <tr key={key}>
                        <td>{CAP_LABELS[key]}</td>
                        <td>
                          <Badge
                            tone={
                              cap.state === 'enabled'
                                ? 'success'
                                : cap.state === 'not_supported'
                                  ? 'neutral'
                                  : 'warning'
                            }
                          >
                            {cap.state.replace('_', ' ')}
                          </Badge>
                        </td>
                        <td className="r-small">
                          {cap.message}
                          {cap.fallback ? (
                            <span className="r-xs r-muted">
                              {' '}
                              · fallback: {cap.fallback.replace('_', ' ')}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {a.formatProfile ? (
              <p className="r-xs r-muted">Format rules: {a.formatProfile.source}.</p>
            ) : null}
            <p className="r-xs r-muted">
              Used by:{' '}
              {a.usedBy.length ? a.usedBy.map((u) => `${u.pageName}`).join(', ') : 'no pages yet'} ·
              health checked{' '}
              {a.healthCheckedAt
                ? formatDateTime(a.healthCheckedAt, wc.workspace.timezone)
                : 'never'}
            </p>
          </Card>
        ))}
      </div>
      <Card className="r-stack">
        <h2>Connect an account</h2>
        <div className="r-table-wrap">
          <table className="r-table">
            <thead>
              <tr>
                <th scope="col">Platform</th>
                <th scope="col">Live connection</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => (
                <tr key={p.id}>
                  <td className="r-strong">
                    {p.label}
                    <span className="r-xs r-muted"> · {p.roles.join(' + ')}</span>
                  </td>
                  <td>
                    <Badge tone="neutral">Not available ({p.live.milestone})</Badge>
                  </td>
                  <td className="r-small">
                    {p.liveUnavailableReason} {p.live.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {manage && data.demoMode ? <DemoConnectionForm workspaceId={wc.workspace.id} /> : null}
      </Card>
    </>
  );
}
