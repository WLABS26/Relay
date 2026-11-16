'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Clapperboard, Download, FilePlus2, RefreshCw } from 'lucide-react';
import { PROVIDER_LABELS, type DestinationProviderId } from '@relay/domain';
import { Badge, Banner, Button, Card, ProgressBar, SimulatedBadge } from '@relay/ui';
import { useToast } from '@relay/ui/client';
import { apiFetch, errorMessage, newIdempotencyKey, poll } from '@/lib/client/api';
import { formatBytes } from '@/lib/format';
import { useSignedVideoUrl } from './media';
import type { JobResponse, WireClipDetail, WireClipRender } from './types';

export interface HandoffDestination {
  id: string;
  label: string;
  provider: string;
  simulated: boolean;
  active: boolean;
}

type RenderState = 'none' | 'stale' | 'running' | 'failed' | 'ready';

const RENDER_FAILURES: Record<string, string> = {
  rights_revoked: 'The rights recorded for the source video no longer allow editing it.',
  source_changed: 'The source video changed after this clip was made.',
  media_not_ready: 'The source video was not ready to be read.',
  render_failed: 'The encoder could not produce this clip.',
  processing_failed: 'Something went wrong while rendering.',
};

function isRunning(render: WireClipRender | null): boolean {
  if (!render) return false;
  if (render.status === 'queued' || render.status === 'running') return true;
  // The job is finished but the derived asset has not been released yet.
  return render.status === 'succeeded' && render.outputAssetStatus === 'validating';
}

function renderState(render: WireClipRender | null, upToDate: boolean): RenderState {
  if (!render) return 'none';
  if (!upToDate) return 'stale';
  if (isRunning(render)) return 'running';
  if (render.status === 'succeeded' && render.outputAssetStatus === 'ready') return 'ready';
  return 'failed';
}

/**
 * Render the saved clip, follow the job through the API, then preview the result, download it
 * or hand it over as a draft post. Nothing here publishes: the draft still goes through review,
 * approval and scheduling on the post screen.
 */
export function RenderPanel({
  slug,
  workspaceId,
  clipId,
  currentRevisionId,
  render,
  dirty,
  canSave,
  perms,
  destinations,
  onSaveFirst,
  onRenderStarted,
  onRefresh,
}: {
  slug: string;
  workspaceId: string;
  clipId: string;
  currentRevisionId: string;
  render: WireClipRender | null;
  /** The editor holds changes that are not saved yet. */
  dirty: boolean;
  /** The editor's state is valid and may be saved. */
  canSave: boolean;
  perms: { create: boolean; export: boolean };
  destinations: HandoffDestination[];
  onSaveFirst: () => Promise<boolean>;
  onRenderStarted: (render: WireClipRender) => void;
  onRefresh: (signal?: AbortSignal) => Promise<WireClipDetail>;
}) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const base = `/api/v1/workspaces/${workspaceId}/clips/${clipId}`;
  const jobUrls = useRef<Record<string, string>>({});
  const refresh = useRef(onRefresh);
  useEffect(() => {
    refresh.current = onRefresh;
  });

  const [busy, setBusy] = useState<'render' | 'export' | 'post' | null>(null);
  const [error, setError] = useState<{ key: 'render' | 'export' | 'post'; message: string } | null>(
    null,
  );
  const [progress, setProgress] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [checkNonce, setCheckNonce] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [outputFailed, setOutputFailed] = useState(false);

  const upToDate = !dirty && render?.revisionId === currentRevisionId;
  const state = renderState(render, upToDate);
  const output = useSignedVideoUrl(
    workspaceId,
    state === 'ready' && render ? render.outputAssetId : null,
  );

  // Follow a render that is queued or running: its job for the percentage when this page
  // started it, then the clip itself until the render and its output asset are final.
  const followId = state === 'running' && render ? render.id : null;
  useEffect(() => {
    if (!followId) return;
    const controller = new AbortController();
    const options = {
      initialMs: 1000,
      maxMs: 4000,
      timeoutMs: 20 * 60_000,
      signal: controller.signal,
    };
    const follow = async () => {
      try {
        const jobUrl = jobUrls.current[followId];
        if (jobUrl) {
          await poll(
            async () => {
              const result = await apiFetch<JobResponse>(jobUrl, { signal: controller.signal });
              setProgress(result.job.progress);
              return result;
            },
            (r) =>
              r.entity.status === 'succeeded' ||
              r.entity.status === 'failed' ||
              r.job.status === 'failed',
            options,
          );
        }
        const detail = await poll(
          () => refresh.current(controller.signal),
          (d) => !isRunning(d.latestRender),
          options,
        );
        const latest = detail.latestRender;
        if (isRunning(latest)) {
          setStalled(true);
        } else if (latest?.status === 'succeeded' && latest.outputAssetStatus === 'ready') {
          setAnnouncement('The clip is rendered and ready.');
          toast('success', 'Clip rendered');
        } else {
          setAnnouncement('The render failed.');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setStalled(true);
          setError({ key: 'render', message: errorMessage(e) });
        }
      }
    };
    void follow();
    return () => controller.abort();
  }, [followId, checkNonce, toast]);

  async function startRender() {
    setBusy('render');
    setError(null);
    setAnnouncement('');
    try {
      if (dirty && !(await onSaveFirst())) return;
      const started = await apiFetch<{
        renderJobId: string;
        revisionId: string;
        outputAssetId: string;
        jobUrl: string | null;
        status: 'queued' | 'running' | 'succeeded';
      }>(`${base}/renders`, { body: {}, idempotencyKey: newIdempotencyKey('render') });
      if (started.jobUrl) jobUrls.current[started.renderJobId] = started.jobUrl;
      setProgress(0);
      setStalled(false);
      setOutputFailed(false);
      if (started.status === 'succeeded') {
        // An identical edit was rendered before: the stored result is reused.
        await onRefresh();
        setAnnouncement('This edit was already rendered. The clip is ready.');
      } else {
        onRenderStarted({
          id: started.renderJobId,
          revisionId: started.revisionId,
          status: started.status,
          errorCode: null,
          errorDetail: null,
          outputAssetId: started.outputAssetId,
          outputAssetStatus: 'validating',
          createdAt: new Date().toISOString(),
          finishedAt: null,
        });
        setAnnouncement('Rendering started.');
      }
    } catch (e) {
      setError({ key: 'render', message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy('export');
    setError(null);
    try {
      const file = await apiFetch<{ url: string; filename: string; sizeBytes: number }>(
        `${base}/exports`,
        { method: 'POST' },
      );
      // The link is followed as a navigation, so only an ordinary web address is accepted.
      if (!/^https?:\/\//i.test(file.url)) throw new Error('The download link was not usable.');
      const link = document.createElement('a');
      link.href = file.url;
      link.download = file.filename;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      setAnnouncement(`Download started: ${file.filename}, ${formatBytes(file.sizeBytes)}.`);
    } catch (e) {
      setError({ key: 'export', message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function createDraft() {
    setBusy('post');
    setError(null);
    try {
      const created = await apiFetch<{ postId: string }>(`${base}/posts`, {
        body: {},
        idempotencyKey: newIdempotencyKey('clip-post'),
      });
      router.push(`/w/${slug}/posts/${created.postId}`);
    } catch (e) {
      setError({ key: 'post', message: errorMessage(e) });
      setBusy(null);
    }
  }

  // The draft starts with every enabled destination of the page, as the service defaults to.
  const enabled = destinations;
  const renderLabel = dirty ? 'Save and render' : state === 'none' ? 'Render clip' : 'Render again';
  const errorFor = (key: 'render' | 'export' | 'post') =>
    error?.key === key ? error.message : null;

  return (
    <Card className="r-stack" aria-labelledby={`${ids}-title`}>
      <div className="r-spread">
        <h2 id={`${ids}-title`}>Render and hand off</h2>
        <RenderBadge state={state} />
      </div>
      <p className="r-visually-hidden" role="status">
        {announcement}
      </p>

      {state === 'none' ? (
        <p className="r-small">
          Rendering cuts the saved range out of the source, applies the shape and burns in the
          captions. The source video is never changed.
        </p>
      ) : null}
      {state === 'stale' ? (
        <Banner
          tone="info"
          title={dirty ? 'You have unsaved changes' : 'Changed since the last render'}
        >
          The last render shows an earlier version of this clip. Render again to download it or
          create a draft post from it.
        </Banner>
      ) : null}
      {state === 'running' ? (
        <div className="r-stack-sm">
          <ProgressBar value={Math.max(progress, 3)} label="Rendering the clip" />
          <p className="r-small" role="status">
            {stalled
              ? 'This is taking longer than expected. The render may still be running.'
              : render?.status === 'queued' && progress === 0
                ? 'Waiting for a worker to pick up the render.'
                : 'Rendering. You can leave this page; the result is kept.'}
          </p>
          {stalled ? (
            <div>
              <Button
                icon={<RefreshCw aria-hidden />}
                onClick={() => {
                  setStalled(false);
                  setError(null);
                  setCheckNonce((n) => n + 1);
                }}
              >
                Check again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {state === 'failed' ? (
        <Banner tone="danger" title="The last render failed">
          {RENDER_FAILURES[render?.errorCode ?? ''] ??
            'Something went wrong while rendering this clip.'}{' '}
          Nothing was published or handed off.
        </Banner>
      ) : null}

      {state === 'ready' ? (
        <div className="r-stack">
          <div className="clip-player clip-player--output">
            <video
              src={output.url ?? undefined}
              controls
              playsInline
              preload="metadata"
              aria-label="Rendered clip"
              onError={() => {
                if (output.url && !output.refresh()) setOutputFailed(true);
              }}
            />
          </div>
          {output.error || outputFailed ? (
            <Banner tone="warning" live title="The rendered clip cannot be played here">
              {output.error ?? 'The video did not load. Reload the page to try again.'}
            </Banner>
          ) : null}

          {perms.create ? (
            <div className="r-stack-sm">
              <h3>Create a draft post</h3>
              {enabled.length > 0 ? (
                <>
                  <p className="r-small">
                    The draft uses this rendered clip and starts with these destinations. Nothing is
                    published: it still needs review, approval and a schedule.
                  </p>
                  <ul className="plain-list r-stack-sm">
                    {enabled.map((d) => (
                      <li key={d.id} className="r-row-tight r-small">
                        <span>{d.label}</span>
                        <Badge>
                          {PROVIDER_LABELS[d.provider as DestinationProviderId] ?? d.provider}
                        </Badge>
                        {d.simulated ? <SimulatedBadge /> : null}
                        {d.active ? null : <Badge tone="warning">Needs reconnecting</Badge>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="r-small">
                  This page has no enabled destination yet. Add one under Pages &amp; rules, then
                  create the draft.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {errorFor('render') ? (
        <Banner tone="danger" live title="The render could not be started">
          {errorFor('render')}
        </Banner>
      ) : null}
      {errorFor('export') ? (
        <Banner tone="danger" live title="The download could not be prepared">
          {errorFor('export')}
        </Banner>
      ) : null}
      {errorFor('post') ? (
        <Banner tone="danger" live title="The draft post could not be created">
          {errorFor('post')}
        </Banner>
      ) : null}

      <div className="r-row-tight">
        {state === 'ready' ? (
          <>
            {perms.create ? (
              <Button
                variant="primary"
                icon={<FilePlus2 aria-hidden />}
                busy={busy === 'post'}
                disabled={enabled.length === 0 || (busy !== null && busy !== 'post')}
                onClick={createDraft}
              >
                Create draft post
              </Button>
            ) : null}
            {perms.export ? (
              <Button
                icon={<Download aria-hidden />}
                busy={busy === 'export'}
                disabled={busy !== null && busy !== 'export'}
                onClick={download}
              >
                Download MP4
              </Button>
            ) : null}
          </>
        ) : perms.create && state !== 'running' ? (
          <Button
            variant="primary"
            icon={<Clapperboard aria-hidden />}
            busy={busy === 'render'}
            disabled={dirty && !canSave}
            onClick={startRender}
          >
            {renderLabel}
          </Button>
        ) : null}
      </div>
      {!perms.create && state !== 'ready' ? (
        <p className="r-small r-muted">Your role cannot render clips.</p>
      ) : null}
    </Card>
  );
}

function RenderBadge({ state }: { state: RenderState }) {
  switch (state) {
    case 'none':
      return <Badge>Not rendered</Badge>;
    case 'stale':
      return <Badge tone="warning">Render out of date</Badge>;
    case 'running':
      return <Badge tone="info">Rendering</Badge>;
    case 'failed':
      return <Badge tone="danger">Render failed</Badge>;
    case 'ready':
      return <Badge tone="success">Rendered</Badge>;
  }
}
