import type { Metadata } from 'next';
import { can, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES } from '@relay/domain';
import { listMembers } from '@relay/services';
import { Card } from '@relay/ui';
import { InviteForm, MemberActions, RevokeInvitationButton } from '@/components/settings/MemberForms';
import { formatDateTime } from '@/lib/format';
import { loadWorkspace } from '@/lib/server/workspace';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const wc = await loadWorkspace(slug);
  const data = await listMembers(wc.ctx, wc.user, wc.workspace.id);
  const manage = can(wc.member.role, 'members.manage');
  const pageName = (id: string) => wc.pages.find((p) => p.id === id)?.name ?? 'Unknown page';
  return (
    <>
      <div className="app-page-header">
        <div>
          <h1>Members</h1>
          <p>Roles decide what each person can do; page access limits where.</p>
        </div>
      </div>
      <div className="r-table-wrap">
        <table className="r-table">
          <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Pages</th>{manage ? <th scope="col">Manage</th> : null}</tr></thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td><div className="r-stack-sm" style={{ gap: 2 }}><span className="r-strong">{m.displayName}</span><span className="r-xs r-muted">{m.email}{m.isDemo ? ' · demo' : ''}</span></div></td>
                <td>{ROLE_LABELS[m.role]}</td>
                <td className="r-small">{m.allPages ? 'All pages' : m.pageIds.map(pageName).join(', ') || 'None'}</td>
                {manage ? (
                  <td>
                    <MemberActions workspaceId={wc.workspace.id} membershipId={m.id} version={m.version} role={m.role} actorRole={wc.member.role} self={m.userId === wc.user.userId} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {manage ? (
        <Card className="r-stack">
          <h2>Invite someone</h2>
          <InviteForm workspaceId={wc.workspace.id} actorRole={wc.member.role} pages={wc.pages.map((p) => ({ id: p.id, name: p.name }))} />
          {data.invitations.length > 0 ? (
            <div className="r-stack-sm">
              <h3 className="r-section-title">Pending invitations</h3>
              <ul className="r-stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.invitations.map((i) => (
                  <li key={i.id} className="r-spread r-small">
                    <span>{i.emailNormalized} · {ROLE_LABELS[i.role as (typeof ROLES)[number]]} · expires {formatDateTime(i.expiresAt, wc.workspace.timezone)}</span>
                    <RevokeInvitationButton workspaceId={wc.workspace.id} invitationId={i.id} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}
      <Card className="r-stack-sm">
        <h2>What roles can do</h2>
        <dl className="r-dl">
          {ROLES.map((r) => (
            <div key={r} style={{ display: 'contents' }}>
              <dt>{ROLE_LABELS[r]}</dt>
              <dd>{ROLE_DESCRIPTIONS[r]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
