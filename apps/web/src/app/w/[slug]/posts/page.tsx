import type { Metadata } from 'next';
import Link from 'next/link';
import { LayoutList, Upload } from 'lucide-react';
import { DESTINATION_STATES, STATE_LABELS, type DestinationState } from '@relay/domain';
import { listPosts } from '@relay/services';
import { EmptyState, linkButtonClass, SampleBadge } from '@relay/ui';
import { RollupBadge, StateBadge } from '@/components/status/StateBadge';
import { formatDateTime } from '@/lib/format';
import { loadWorkspace, selectedPage } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Content' };

export default async function PostsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string; state?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const wc = await loadWorkspace(slug);
  const page = selectedPage(wc, sp.page);
  const state = (DESTINATION_STATES as readonly string[]).includes(sp.state ?? '') ? (sp.state as DestinationState) : undefined;
  const { posts } = await listPosts(wc.ctx, wc.user, wc.workspace.id, { pageId: page?.id, state });
  const zone = page?.timezone ?? wc.workspace.timezone;
  const filterHref = (s?: string) => {
    const q = new URLSearchParams();
    if (page) q.set('page', page.id);
    if (s) q.set('state', s);
    return `/w/${slug}/posts${q.size ? `?${q}` : ''}`;
  };
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Content</h1>
          <p>{page ? page.name : 'All pages'} · {posts.length} post{posts.length === 1 ? '' : 's'}</p>
        </div>
        <Link className={linkButtonClass('primary')} href={`/w/${slug}/upload${page ? `?page=${page.id}` : ''}`}>
          <Upload aria-hidden /> Upload content
        </Link>
      </div>
      <nav aria-label="Filter by state" className="r-row-tight">
        <Link className={linkButtonClass(state ? 'ghost' : 'secondary')} href={filterHref()} aria-current={!state ? 'page' : undefined}>All</Link>
        {(['draft', 'needs_review', 'approved', 'scheduled', 'published', 'blocked', 'failed', 'needs_reconciliation'] as const).map((s) => (
          <Link key={s} className={linkButtonClass(state === s ? 'secondary' : 'ghost')} href={filterHref(s)} aria-current={state === s ? 'page' : undefined}>
            {STATE_LABELS[s]}
          </Link>
        ))}
      </nav>
      {posts.length === 0 ? (
        <EmptyState icon={<LayoutList aria-hidden />} title={state ? `No posts are ${STATE_LABELS[state].toLowerCase()}` : 'No content yet'} action={<Link className={linkButtonClass('secondary')} href={`/w/${slug}/upload`}>Upload content</Link>}>
          Upload a video, image or carousel to create a draft.
        </EmptyState>
      ) : (
        <div className="r-table-wrap">
          <table className="r-table">
            <thead>
              <tr>
                <th scope="col" className="col-post">Post</th>
                <th scope="col">Status</th>
                <th scope="col">Destinations</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td className="col-post">
                    <div className="r-row" style={{ flexWrap: 'nowrap' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- private, short-lived signed URL: the image optimizer must not fetch or cache tenant media */}
                      {p.thumbnailUrl ? <img className="r-thumb" src={p.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <div className="r-thumb" aria-hidden />}
                      <div className="r-stack-sm" style={{ gap: 2, minWidth: 0 }}>
                        <Link href={`/w/${slug}/posts/${p.id}`} className="r-strong">{p.title ?? (p.caption?.slice(0, 60) || 'Untitled post')}</Link>
                        <span className="r-xs r-muted">{p.pageName} · revision {p.revisionNumber}</span>
                        {p.isSample ? <span><SampleBadge /></span> : null}
                      </div>
                    </div>
                  </td>
                  <td><RollupBadge rollup={p.rollup} /></td>
                  <td>
                    <ul className="r-stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {p.destinations.map((d) => (
                        <li key={d.id} className="r-row-tight">
                          <StateBadge state={d.state as DestinationState} />
                          <span className="r-xs">{d.label}</span>
                          {d.plannedAt ? <span className="r-xs r-muted r-tabular">{formatDateTime(d.plannedAt, zone)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="r-nowrap r-tabular r-muted">{formatDateTime(p.updatedAt, zone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
