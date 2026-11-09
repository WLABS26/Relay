import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleCheck, Plug, Upload } from 'lucide-react';
import {
  PROVIDER_LABELS,
  STATE_DESCRIPTIONS,
  type DestinationProviderId,
  type DestinationState,
} from '@relay/domain';
import { getInbox } from '@relay/services';
import { Banner, Card, EmptyState, linkButtonClass, SimulatedBadge } from '@relay/ui';
import { StateBadge } from '@/components/status/StateBadge';
import { formatDateTime, relativeTime } from '@/lib/format';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Inbox' };

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const { page } = await searchParams;
  const wc = await loadWorkspace(slug);
  const inbox = await getInbox(wc.ctx, wc.user, wc.workspace.id);
  const items = page ? inbox.items.filter((i) => i.pageId === page) : inbox.items;
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Inbox</h1>
          <p>Reviews, blocked posts, failures and unknown outcomes that need a person.</p>
        </div>
        <div className="app-actions">
          <Link
            className={linkButtonClass('primary')}
            href={`/w/${slug}/upload${page ? `?page=${page}` : ''}`}
          >
            <Upload aria-hidden /> Upload content
          </Link>
        </div>
      </div>
      {inbox.accounts.length > 0 ? (
        <Banner tone="warning" title="Connections need attention">
          {inbox.accounts
            .map(
              (a) =>
                `${a.displayName} (${PROVIDER_LABELS[a.provider as DestinationProviderId] ?? a.provider}): ${a.status}`,
            )
            .join(' · ')}
          . <Link href={`/w/${slug}/settings/connections`}>Review connections</Link>
        </Banner>
      ) : null}
      {items.length === 0 ? (
        <EmptyState icon={<CircleCheck aria-hidden />} title="Nothing needs you right now">
          New reviews, blocked posts and publishing problems will appear here.
        </EmptyState>
      ) : (
        <ul
          className="r-stack-sm"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
          aria-label="Items needing attention"
        >
          {items.map((item) => (
            <li key={item.id}>
              <Card as="div" className="r-spread">
                <div className="r-stack-sm" style={{ minWidth: 0, flex: 1 }}>
                  <div className="r-row-tight">
                    <StateBadge state={item.state as DestinationState} />
                    {item.connectionMode === 'simulated' ? <SimulatedBadge /> : null}
                    <span className="r-xs r-muted">
                      {item.pageName} · {item.label}
                    </span>
                  </div>
                  <Link href={`/w/${slug}/posts/${item.postId}`} className="r-strong r-truncate">
                    {item.title ?? item.caption?.slice(0, 80) ?? 'Untitled post'}
                  </Link>
                  <span className="r-small r-muted">
                    {item.reasonLabel ?? STATE_DESCRIPTIONS[item.state as DestinationState]}
                  </span>
                </div>
                <div className="r-stack-sm r-small r-muted" style={{ textAlign: 'right' }}>
                  {item.plannedAt ? (
                    <span className="r-tabular">
                      Planned {formatDateTime(item.plannedAt, wc.workspace.timezone)}
                    </span>
                  ) : null}
                  <span>Updated {relativeTime(item.stateChangedAt)}</span>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {wc.pages.length === 0 ? (
        <EmptyState
          icon={<Plug aria-hidden />}
          title="Set up your first page"
          action={
            <Link className={linkButtonClass('secondary')} href={`/w/${slug}/settings/pages`}>
              Add a page
            </Link>
          }
        >
          A page holds destinations, publishing rules and a calendar.
        </EmptyState>
      ) : null}
    </>
  );
}
