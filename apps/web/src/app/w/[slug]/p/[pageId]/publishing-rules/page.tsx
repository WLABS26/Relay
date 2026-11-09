import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, isAppError, isUuid } from '@relay/domain';
import { getPageDetail } from '@relay/services';
import { Card } from '@relay/ui';
import { PauseControl, RulesForm } from '@/components/settings/RulesForm';
import { formatDateTime } from '@/lib/format';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Publishing rules' };

export default async function RulesPage({ params }: { params: Promise<{ slug: string; pageId: string }> }) {
  const { slug, pageId } = await params;
  if (!isUuid(pageId)) notFound();
  const wc = await loadWorkspace(slug);
  let detail;
  try {
    detail = await getPageDetail(wc.ctx, wc.user, wc.workspace.id, pageId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const canEdit = can(wc.member.role, 'page.rules.update');
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Publishing rules · {detail.page.name}</h1>
          <p>Times use {detail.page.timezone}. Every save creates a new immutable revision; schedules keep the instant they were given.</p>
        </div>
      </div>
      <PauseControl
        workspaceId={wc.workspace.id}
        pageId={pageId}
        paused={Boolean(detail.page.pausedAt)}
        reason={detail.page.pauseReason}
        canPause={can(wc.member.role, 'page.pause')}
        canResume={can(wc.member.role, 'page.resume')}
      />
      <RulesForm workspaceId={wc.workspace.id} pageId={pageId} revision={detail.revision} rules={detail.rules} canEdit={canEdit} canAutomate={['owner', 'admin'].includes(wc.member.role)} />
      <Card className="r-stack-sm">
        <h2>Revision history</h2>
        <ol className="r-small" style={{ margin: 0, paddingLeft: 20 }}>
          {detail.revisions.map((r) => (
            <li key={r.revision}>Revision {r.revision} · {formatDateTime(r.createdAt, detail.page.timezone)}</li>
          ))}
        </ol>
      </Card>
    </>
  );
}
