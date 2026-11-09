'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { CalendarClock, CircleCheck, ExternalLink, Lock, LockOpen, RefreshCw, Send, Undo2, X } from 'lucide-react';
import {
  BLOCK_REASONS,
  PROVIDER_LABELS,
  STATE_DESCRIPTIONS,
  VISIBILITY_LABELS,
  type DestinationProviderId,
  type DestinationState,
  type Visibility,
} from '@relay/domain';
import type { getPostDetail } from '@relay/services';
import { Badge, Banner, Button, Card, describedBy, Field, SampleBadge, SimulatedBadge } from '@relay/ui';
import { useToast } from '@relay/ui/client';
import { RollupBadge, StateBadge } from '@/components/status/StateBadge';
import { apiFetch, errorMessage } from '@/lib/client/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { ACTION_LABELS } from './labels';
import { ReconcileDialog } from './ReconcileDialog';
import { ScheduleDialog, type ScheduleTarget } from './ScheduleDialog';

type Detail = Omit<Awaited<ReturnType<typeof getPostDetail>>, 'member'>;
type Destination = Detail['destinations'][number];
interface Perms {
  edit: boolean;
  submit: boolean;
  approve: boolean;
  schedule: boolean;
  cancel: boolean;
  retry: boolean;
  reconcile: boolean;
}

const ACTIVE_STATES: DestinationState[] = ['scheduled', 'preparing', 'dispatching', 'processing'];

export function PostWorkspace({
  slug,
  workspaceId,
  data,
  perms,
  visibilityOptions,
}: {
  slug: string;
  workspaceId: string;
  data: Detail;
  perms: Perms;
  visibilityOptions: Record<string, string[]>;
}) {
  const router = useRouter();
  const toast = useToast();
  const zone = data.page.timezone;
  const [scheduleTarget, setScheduleTarget] = useState<{ target: ScheduleTarget; mode: 'schedule' | 'move'; initialLocal: string | null } | null>(null);
  const [reconcileTarget, setReconcileTarget] = useState<{ postDestinationId: string; version: number; label: string; simulated: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Bounded backoff polling while work is in flight, and from 10 minutes before the next
  // planned dispatch. Render only derives pure values; the clock is read inside the effect.
  const active =
    data.destinations.some((d) => d.state === 'preparing' || d.state === 'dispatching' || d.state === 'processing') ||
    data.media.some((m) => m.status === 'validating' || m.status === 'uploading');
  const nextPlannedMs = data.destinations.reduce<number | null>((min, d) => {
    if (d.state !== 'scheduled' || !d.plannedAt) return min;
    const t = new Date(d.plannedAt).getTime();
    return min === null || t < min ? t : min;
  }, null);
  useEffect(() => {
    if (!active && nextPlannedMs === null) return;
    const leadMs = 10 * 60_000;
    const maxWaitMs = 60 * 60_000; // re-check at least hourly; setTimeout overflows past ~24.8 days
    let delay = 1500;
    let timer: number;
    const tick = () => {
      router.refresh();
      delay = Math.min(10_000, Math.round(delay * 1.5));
      timer = window.setTimeout(tick, delay);
    };
    const wake = () => {
      const until = active || nextPlannedMs === null ? 0 : nextPlannedMs - leadMs - Date.now();
      timer = until <= 0 ? window.setTimeout(tick, delay) : window.setTimeout(wake, Math.min(until, maxWaitMs));
    };
    wake();
    return () => window.clearTimeout(timer);
  }, [active, nextPlannedMs, router]);

  async function act(key: string, path: string, body: unknown, success: string) {
    setBusy(key);
    setActionError(null);
    try {
      const result = await apiFetch<{ outcomes?: Array<{ ok: boolean; error?: { message: string } }> }>(`/api/v1/workspaces/${workspaceId}${path}`, { body });
      const failed = result.outcomes?.filter((o) => !o.ok) ?? [];
      if (failed.length) setActionError(failed.map((f) => f.error?.message).join(' '));
      else toast('success', success);
      router.refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const reviewable = data.destinations.filter((d) => d.state === 'needs_review');
  const submittable = data.destinations.filter((d) => d.state === 'draft' || d.state === 'changes_requested');

  return (
    <>
      <div className="app-page-header">
        <div className="r-stack-sm">
          <Link href={`/w/${slug}/posts?page=${data.page.id}`} className="r-small r-muted">← {data.page.name}</Link>
          <h1>{data.revision.title ?? (data.revision.caption.slice(0, 60) || 'Untitled post')}</h1>
          <div className="r-row-tight">
            <RollupBadge rollup={data.rollup} />
            <span className="r-xs r-muted">Revision {data.revision.revisionNumber}</span>
            {data.post.isSample ? <SampleBadge /> : null}
          </div>
        </div>
        <div className="app-actions">
          {perms.submit && submittable.length > 0 ? (
            <Button variant="primary" icon={<Send aria-hidden />} busy={busy === 'submit'} onClick={() => act('submit', `/posts/${data.post.id}/submit`, {}, 'Submitted for review.')}>
              Submit for review
            </Button>
          ) : null}
          {perms.approve && reviewable.length > 1 ? (
            <Button
              variant="primary"
              icon={<CircleCheck aria-hidden />}
              busy={busy === 'approve-all'}
              onClick={() =>
                act('approve-all', `/posts/${data.post.id}/approvals`, { decisions: reviewable.map((d) => ({ postDestinationId: d.id, decision: 'approve', revisionId: data.revision.id, intentHash: d.intentHash })) }, 'Approved all destinations.')
              }
            >
              Approve all ({reviewable.length})
            </Button>
          ) : null}
        </div>
      </div>

      {actionError ? <Banner tone="danger" live title="That did not work">{actionError}</Banner> : null}
      {data.page.pausedAt ? <Banner tone="warning" title="This page is paused">Scheduled posts will be held until the page is resumed.</Banner> : null}

      <Card className="r-stack">
        <h2>Media</h2>
        <ul className="media-strip" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Media in order">
          {data.media.map((m, i) => (
            <li key={m.assetId} className="media-tile">
              {/* eslint-disable-next-line @next/next/no-img-element -- private, short-lived signed URL: the image optimizer must not fetch or cache tenant media */}
              {m.thumbnailUrl ? <img src={m.thumbnailUrl} alt={`Media ${i + 1} preview`} decoding="async" /> : <div className="media-placeholder r-xs r-muted">{m.status === 'ready' ? 'No preview' : 'Validating…'}</div>}
              <span className="r-xs r-tabular r-muted">
                {i + 1}. {m.kind} · {m.width}×{m.height}{m.durationMs ? ` · ${formatDuration(m.durationMs)}` : ''}
              </span>
              {m.status !== 'ready' ? <Badge tone={m.status === 'rejected' ? 'danger' : 'info'}>{m.status}</Badge> : null}
            </li>
          ))}
        </ul>
      </Card>

      {perms.edit ? <ContentEditor key={data.revision.id} workspaceId={workspaceId} data={data} visibilityOptions={visibilityOptions} /> : null}

      <section className="r-stack" aria-labelledby="destinations-heading">
        <h2 id="destinations-heading">Destinations</h2>
        <div className="r-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
          {data.destinations.map((d) => (
            <DestinationCard
              key={d.id}
              d={d}
              zone={zone}
              perms={perms}
              busy={busy}
              revisionId={data.revision.id}
              onApprove={(decision, note) =>
                act(`${decision}-${d.id}`, `/posts/${data.post.id}/approvals`, { decisions: [{ postDestinationId: d.id, decision, revisionId: data.revision.id, intentHash: d.intentHash, ...(note ? { note } : {}) }] }, decision === 'approve' ? 'Approved.' : 'Changes requested.')
              }
              onSubmit={() => act(`submit-${d.id}`, `/posts/${data.post.id}/submit`, { postDestinationIds: [d.id] }, 'Submitted for review.')}
              onSchedule={(mode) =>
                setScheduleTarget({
                  mode,
                  initialLocal: mode === 'move' ? d.civilLocal : null,
                  target: { postDestinationId: d.id, version: d.version, label: d.label, accountName: d.account.displayName, provider: d.account.provider, connectionMode: d.account.connectionMode, visibility: d.payload.visibility },
                })
              }
              onUnschedule={() => act(`cancel-${d.id}`, `/post-destinations/${d.id}/cancel`, { expectedVersion: d.version }, 'Unscheduled. The approval is still valid.')}
              onLock={(locked) => act(`lock-${d.id}`, `/post-destinations/${d.id}/lock`, { expectedVersion: d.version, locked }, locked ? 'Slot locked.' : 'Slot unlocked.')}
              onRetry={() => act(`retry-${d.id}`, `/post-destinations/${d.id}/retry`, { expectedVersion: d.version }, 'Retry queued from the last verified step.')}
              onReconcile={() => setReconcileTarget({ postDestinationId: d.id, version: d.version, label: d.label, simulated: d.account.connectionMode === 'simulated' })}
            />
          ))}
        </div>
      </section>

      <Card className="r-stack">
        <h2>Lineage</h2>
        <p className="r-small r-muted">Every step from upload to publication, in order. Times in {zone}.</p>
        <ol className="timeline">
          {data.timeline.map((e) => (
            <li key={e.id}>
              <span className="r-tabular r-muted">{formatDateTime(e.occurredAt, zone, { second: '2-digit' })}</span>
              <span>
                <span className="r-strong">{ACTION_LABELS[e.action] ?? e.action}</span> <span className="r-muted">· {e.actorLabel}</span>
                <TimelineData data={e.data as Record<string, unknown>} zone={zone} />
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <ScheduleDialog
        open={scheduleTarget !== null}
        onClose={() => setScheduleTarget(null)}
        workspaceId={workspaceId}
        zone={zone}
        target={scheduleTarget?.target ?? null}
        mode={scheduleTarget?.mode}
        initialLocal={scheduleTarget?.initialLocal}
      />
      <ReconcileDialog open={reconcileTarget !== null} onClose={() => setReconcileTarget(null)} workspaceId={workspaceId} target={reconcileTarget} />
    </>
  );
}

function TimelineData({ data, zone }: { data: Record<string, unknown>; zone: string }) {
  const bits: string[] = [];
  if (typeof data.local === 'string') bits.push(`${String(data.local).replace('T', ' ')} ${String(data.zone ?? '')} (${String(data.offset ?? '')})`);
  if (typeof data.plannedAt === 'string' && typeof data.local !== 'string') bits.push(`planned ${formatDateTime(data.plannedAt, zone)}`);
  if (typeof data.account === 'string') bits.push(String(data.account));
  if (typeof data.externalId === 'string') bits.push(`post ${data.externalId}`);
  if (typeof data.reason === 'string') bits.push(String(data.reason));
  if (typeof data.code === 'string') bits.push(String(data.code));
  if (data.simulated === true || data.connectionMode === 'simulated') bits.push('simulated');
  return bits.length ? <span className="r-xs r-muted"> — {bits.join(' · ')}</span> : null;
}

function DestinationCard({
  d,
  zone,
  perms,
  busy,
  onApprove,
  onSubmit,
  onSchedule,
  onUnschedule,
  onLock,
  onRetry,
  onReconcile,
}: {
  d: Destination;
  zone: string;
  perms: Perms;
  busy: string | null;
  revisionId: string;
  onApprove: (decision: 'approve' | 'reject', note?: string) => void;
  onSubmit: () => void;
  onSchedule: (mode: 'schedule' | 'move') => void;
  onUnschedule: () => void;
  onLock: (locked: boolean) => void;
  onRetry: () => void;
  onReconcile: () => void;
}) {
  const ids = useId();
  const [note, setNote] = useState('');
  const state = d.state as DestinationState;
  const reason = d.stateReason && d.stateReason in BLOCK_REASONS ? BLOCK_REASONS[d.stateReason as keyof typeof BLOCK_REASONS] : null;
  const blocking = d.issues.filter((i) => i.blocks === 'submit');
  const scheduleIssue = d.issues.find((i) => i.blocks === 'schedule');
  const provider = PROVIDER_LABELS[d.account.provider as DestinationProviderId] ?? d.account.provider;
  return (
    <Card as="article" className="dest-card" aria-labelledby={`${ids}-h`}>
      <div className="r-spread">
        <div className="r-stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <h3 id={`${ids}-h`} className="r-truncate">{d.label}</h3>
          <span className="r-row-tight r-xs r-muted">
            {provider} · {d.account.displayName}
            {d.account.connectionMode === 'simulated' ? <SimulatedBadge /> : null}
          </span>
        </div>
        <StateBadge state={state} />
      </div>
      <p className="r-small r-secondary">{reason ?? STATE_DESCRIPTIONS[state]}</p>

      <dl className="r-dl">
        <dt>Visibility</dt>
        <dd>{VISIBILITY_LABELS[d.payload.visibility as Visibility] ?? d.payload.visibility}</dd>
        {d.plannedAt ? (
          <>
            <dt>Planned</dt>
            <dd className="r-tabular">
              {formatDateTime(d.plannedAt, zone)} <span className="r-muted">({d.civilOffset})</span>
              {d.locked ? <span className="r-row-tight r-xs"><Lock aria-hidden width={14} height={14} /> Locked</span> : null}
            </dd>
          </>
        ) : null}
        {d.publishedAt ? (
          <>
            <dt>Published</dt>
            <dd className="r-tabular">{formatDateTime(d.publishedAt, zone, { second: '2-digit' })}</dd>
            <dt>Platform post</dt>
            <dd>
              <code>{d.externalId}</code>
              {d.permalink && d.publishedMode !== 'simulated' ? (
                <a href={d.permalink} target="_blank" rel="noreferrer noopener" className="r-row-tight r-xs">Open <ExternalLink aria-hidden width={12} height={12} /></a>
              ) : d.publishedMode === 'simulated' ? <span className="r-xs r-muted"> (simulated — not a real post)</span> : null}
              {d.linkMethod === 'operator_linked' ? <span className="r-xs r-muted"> · linked by an operator</span> : null}
            </dd>
          </>
        ) : null}
        {d.approval ? (
          <>
            <dt>Approval</dt>
            <dd>
              {d.approval.decidedByName}, {formatDateTime(d.approval.decidedAt, zone)}
              {d.approvalStale ? <span className="r-error-text"> · stale: content or rights changed</span> : null}
            </dd>
          </>
        ) : null}
      </dl>

      {blocking.length > 0 ? (
        <Banner tone="warning" title="Fix before review">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{blocking.map((i) => <li key={`${i.code}-${i.message}`}>{i.message}</li>)}</ul>
        </Banner>
      ) : null}
      {scheduleIssue && blocking.length === 0 ? (
        <Banner tone="info" title={scheduleIssue.fallback === 'manual_export' ? 'Manual export only' : 'Automatic publishing unavailable'}>
          {scheduleIssue.message}
        </Banner>
      ) : null}

      <div className="r-row-tight">
        {perms.submit && (state === 'draft' || state === 'changes_requested') ? (
          <Button icon={<Send aria-hidden />} busy={busy === `submit-${d.id}`} disabled={blocking.length > 0} onClick={onSubmit}>Submit</Button>
        ) : null}
        {perms.approve && state === 'needs_review' ? (
          <div className="r-stack-sm" style={{ width: '100%' }}>
            <Field id={`${ids}-note`} label="Review note (optional)">
              <input id={`${ids}-note`} className="r-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-describedby={describedBy(`${ids}-note`, {})} />
            </Field>
            <div className="r-row-tight">
              <Button variant="primary" icon={<CircleCheck aria-hidden />} busy={busy === `approve-${d.id}`} disabled={blocking.length > 0} onClick={() => onApprove('approve', note || undefined)}>
                Approve this version
              </Button>
              <Button icon={<Undo2 aria-hidden />} busy={busy === `reject-${d.id}`} onClick={() => onApprove('reject', note || undefined)}>Request changes</Button>
            </div>
          </div>
        ) : null}
        {perms.schedule && state === 'approved' && !d.approvalStale ? (
          <Button variant="primary" icon={<CalendarClock aria-hidden />} disabled={Boolean(scheduleIssue)} onClick={() => onSchedule('schedule')}>Schedule</Button>
        ) : null}
        {perms.submit && state === 'approved' && d.approvalStale ? <Button icon={<Send aria-hidden />} onClick={onSubmit}>Request re-approval</Button> : null}
        {perms.schedule && ['scheduled', 'preparing', 'blocked', 'failed'].includes(state) ? (
          <Button icon={<CalendarClock aria-hidden />} disabled={Boolean(d.locked)} onClick={() => onSchedule('move')} title={d.locked ? 'Unlock the slot to move it' : undefined}>Move</Button>
        ) : null}
        {perms.schedule && d.slotAt && ACTIVE_STATES.includes(state) ? (
          <Button variant="ghost" icon={d.locked ? <LockOpen aria-hidden /> : <Lock aria-hidden />} busy={busy === `lock-${d.id}`} onClick={() => onLock(!d.locked)}>{d.locked ? 'Unlock' : 'Lock slot'}</Button>
        ) : null}
        {perms.cancel && ['scheduled', 'preparing', 'blocked', 'failed'].includes(state) ? (
          <Button variant="ghost" icon={<X aria-hidden />} busy={busy === `cancel-${d.id}`} onClick={onUnschedule}>Unschedule</Button>
        ) : null}
        {perms.retry && state === 'failed' ? <Button icon={<RefreshCw aria-hidden />} busy={busy === `retry-${d.id}`} onClick={onRetry}>Retry</Button> : null}
        {state === 'needs_reconciliation' ? (
          perms.reconcile ? <Button variant="primary" onClick={onReconcile}>Resolve outcome</Button> : <span className="r-xs r-muted">An owner or admin must resolve this.</span>
        ) : null}
      </div>

      {d.attempts.length > 0 ? (
        <details>
          <summary className="r-small" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Publish attempts ({d.attempts.length})</summary>
          <div className="r-table-wrap">
            <table className="r-table">
              <thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Result</th><th scope="col">Started</th></tr></thead>
              <tbody>
                {d.attempts.map((a) => (
                  <tr key={a.id}>
                    <td className="r-tabular">{a.attemptNumber}</td>
                    <td>{a.phase.replace('_', ' ')}</td>
                    <td>{a.status.replace('_', ' ')}{a.errorCode ? <span className="r-xs r-muted"> · {a.errorCode}</span> : null}</td>
                    <td className="r-tabular r-nowrap">{formatDateTime(a.startedAt, zone, { second: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}

function ContentEditor({ workspaceId, data, visibilityOptions }: { workspaceId: string; data: Detail; visibilityOptions: Record<string, string[]> }) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(data.revision.title ?? '');
  const [caption, setCaption] = useState(data.revision.caption);
  const [declarations, setDeclarations] = useState(data.revision.declarations);
  const [variants, setVariants] = useState<Record<string, { caption: string | null; visibility: string }>>(() =>
    Object.fromEntries(
      data.destinations.map((d) => [d.pageDestinationId, { caption: d.payload.caption !== data.revision.caption ? d.payload.caption : null, visibility: d.payload.visibility }]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = data.destinations.some((d) => ['preparing', 'dispatching', 'processing', 'needs_reconciliation'].includes(d.state));
  const approvedOrScheduled = data.destinations.filter((d) => ['approved', 'scheduled', 'blocked'].includes(d.state));

  if (!open) {
    return (
      <Card className="r-stack-sm">
        <div className="r-spread">
          <h2>Copy</h2>
          <Button onClick={() => setOpen(true)} disabled={locked} title={locked ? 'A destination is being published' : undefined}>Edit</Button>
        </div>
        <p className="r-small" style={{ whiteSpace: 'pre-wrap' }}>{data.revision.caption || <span className="r-muted">No caption</span>}</p>
      </Card>
    );
  }

  return (
    <Card className="r-stack">
      <h2>Edit copy</h2>
      {approvedOrScheduled.length > 0 ? (
        <Banner tone="warning" title="Saving creates a new revision">
          Destinations whose content changes lose their approval and are unscheduled. Destinations whose content stays identical keep their approval.
        </Banner>
      ) : null}
      <Field id={`${ids}-t`} label="Title">
        <input id={`${ids}-t`} className="r-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </Field>
      <Field id={`${ids}-c`} label="Caption (all destinations)">
        <textarea id={`${ids}-c`} className="r-textarea" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={5000} />
      </Field>
      <fieldset className="r-fieldset r-stack-sm">
        <legend>Creator declarations</legend>
        <label className="r-check"><input type="checkbox" checked={declarations.paidPartnership} onChange={(e) => setDeclarations({ ...declarations, paidPartnership: e.target.checked })} /><span className="r-small">Includes a paid partnership or sponsorship</span></label>
        <label className="r-check"><input type="checkbox" checked={declarations.alteredOrSyntheticMedia} onChange={(e) => setDeclarations({ ...declarations, alteredOrSyntheticMedia: e.target.checked })} /><span className="r-small">Contains realistic altered or synthetic media</span></label>
      </fieldset>
      {data.destinations.map((d) => {
        const v = variants[d.pageDestinationId]!;
        return (
          <fieldset key={d.id} className="r-fieldset r-stack-sm">
            <legend>{d.label}</legend>
            <Field id={`${ids}-v-${d.id}`} label="Visibility">
              <select id={`${ids}-v-${d.id}`} className="r-select" value={v.visibility} onChange={(e) => setVariants({ ...variants, [d.pageDestinationId]: { ...v, visibility: e.target.value } })}>
                {(visibilityOptions[d.id] ?? []).map((o) => <option key={o} value={o}>{VISIBILITY_LABELS[o as Visibility] ?? o}</option>)}
              </select>
            </Field>
            <label className="r-check">
              <input type="checkbox" checked={v.caption !== null} onChange={(e) => setVariants({ ...variants, [d.pageDestinationId]: { ...v, caption: e.target.checked ? caption : null } })} />
              <span className="r-small">Use a different caption here</span>
            </label>
            {v.caption !== null ? (
              <textarea aria-label={`Caption for ${d.label}`} className="r-textarea" value={v.caption} onChange={(e) => setVariants({ ...variants, [d.pageDestinationId]: { ...v, caption: e.target.value } })} maxLength={5000} />
            ) : null}
          </fieldset>
        );
      })}
      {error ? <Banner tone="danger" live>{error}</Banner> : null}
      <div className="r-row-tight">
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await apiFetch<{ destinations: Array<{ approvalKept: boolean; state: string }> }>(`/api/v1/workspaces/${workspaceId}/posts/${data.post.id}`, {
                method: 'PATCH',
                body: {
                  expectedVersion: data.post.version,
                  title: title.trim() || null,
                  caption,
                  mediaAssetIds: data.media.map((m) => m.assetId),
                  declarations,
                  variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { visibility: v.visibility, caption: v.caption }])),
                },
              });
              const invalidated = result.destinations.filter((x) => !x.approvalKept && x.state === 'draft').length;
              toast('success', invalidated ? `Saved. ${invalidated} destination${invalidated === 1 ? '' : 's'} need re-approval.` : 'Saved.');
              setOpen(false);
              router.refresh();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save revision
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}
