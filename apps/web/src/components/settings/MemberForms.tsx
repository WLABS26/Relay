'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Copy, UserPlus } from 'lucide-react';
import { assignableRoles, ROLE_LABELS, type Role } from '@relay/domain';
import { Banner, Button, Field } from '@relay/ui';
import { useToast } from '@relay/ui/client';
import { apiFetch, errorMessage } from '@/lib/client/api';

export function InviteForm({ workspaceId, actorRole, pages }: { workspaceId: string; actorRole: Role; pages: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const ids = useId();
  const roles = assignableRoles(actorRole);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('editor') ? 'editor' : roles[0]!);
  const [allPages, setAllPages] = useState(true);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scoped = role !== 'owner' && role !== 'admin';
  return (
    <form
      className="r-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setLink(null);
        try {
          const r = await apiFetch<{ acceptPath: string }>(`/api/v1/workspaces/${workspaceId}/invitations`, { body: { email, role, allPages: scoped ? allPages : true, pageIds: scoped && !allPages ? pageIds : [] } });
          setLink(`${window.location.origin}${r.acceptPath}`);
          setEmail('');
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="r-grid">
        <Field id={`${ids}-e`} label="Email">
          <input id={`${ids}-e`} type="email" className="r-input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field id={`${ids}-r`} label="Role">
          <select id={`${ids}-r`} className="r-select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </Field>
      </div>
      {scoped ? (
        <fieldset className="r-fieldset r-stack-sm">
          <legend>Page access</legend>
          <label className="r-check"><input type="checkbox" checked={allPages} onChange={(e) => setAllPages(e.target.checked)} /><span className="r-small">All pages (including future ones)</span></label>
          {!allPages ? pages.map((p) => (
            <label key={p.id} className="r-check"><input type="checkbox" checked={pageIds.includes(p.id)} onChange={(e) => setPageIds((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} /><span className="r-small">{p.name}</span></label>
          )) : null}
        </fieldset>
      ) : null}
      {error ? <Banner tone="danger" live>{error}</Banner> : null}
      {link ? (
        <Banner tone="success" title="Invitation created">
          Email delivery is not part of this build. Share this one-time link (valid 7 days) with the invitee:
          <div className="r-row-tight" style={{ marginTop: 8 }}>
            <code style={{ overflowWrap: 'anywhere' }}>{link}</code>
            <Button variant="ghost" icon={<Copy aria-hidden />} onClick={() => navigator.clipboard?.writeText(link)} aria-label="Copy invitation link" />
          </div>
        </Banner>
      ) : null}
      <div><Button type="submit" icon={<UserPlus aria-hidden />} busy={busy}>Create invitation</Button></div>
    </form>
  );
}

export function MemberActions({ workspaceId, membershipId, version, role, actorRole, self }: { workspaceId: string; membershipId: string; version: number; role: Role; actorRole: Role; self: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const roles = assignableRoles(actorRole);
  const editable = actorRole === 'owner' || role !== 'owner';
  return (
    <div className="r-stack-sm">
      <div className="r-row-tight">
        <select
          className="r-select"
          style={{ width: 'auto' }}
          aria-label="Change role"
          value={role}
          disabled={!editable}
          onChange={async (e) => {
            setError(null);
            try {
              await apiFetch(`/api/v1/workspaces/${workspaceId}/members/${membershipId}`, { method: 'PATCH', body: { expectedVersion: version, role: e.target.value } });
              toast('success', 'Role updated.');
              router.refresh();
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          {(roles.includes(role) ? roles : [role, ...roles]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        {editable ? (
          <Button variant="ghost" onClick={async () => {
            setError(null);
            try {
              await apiFetch(`/api/v1/workspaces/${workspaceId}/members/${membershipId}`, { method: 'DELETE' });
              // Leaving: a full load drops every client-cached view of this workspace,
              // including back/forward entries, so none of it can be shown again.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard navigation
              if (self) window.location.assign('/');
              else router.refresh();
            } catch (err) {
              setError(errorMessage(err));
            }
          }}>{self ? 'Leave' : 'Remove'}</Button>
        ) : null}
      </div>
      {error ? <span className="r-error-text" role="alert">{error}</span> : null}
    </div>
  );
}

export function RevokeInvitationButton({ workspaceId, invitationId }: { workspaceId: string; invitationId: string }) {
  const router = useRouter();
  return (
    <Button variant="ghost" onClick={async () => {
      await apiFetch(`/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`, { method: 'DELETE' }).catch(() => undefined);
      router.refresh();
    }}>Revoke</Button>
  );
}

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="r-stack">
      {error ? <Banner tone="danger" live>{error}</Banner> : null}
      <div>
        <Button variant="primary" busy={busy} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await apiFetch<{ slug: string }>('/api/v1/invitations/accept', { body: { token } });
            router.push(`/w/${r.slug}/inbox`);
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}>Accept invitation</Button>
      </div>
    </div>
  );
}
