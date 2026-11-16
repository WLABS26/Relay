'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Pause, Play, RotateCcw, Save, ZoomIn, ZoomOut } from 'lucide-react';
import {
  CLIP_ASPECTS,
  CLIP_MIN_MS,
  clipGeometry,
  validateClipRange,
  validateCues,
  type ClipAspect,
  type ClipCropMode,
  type Cue,
  type Envelope,
} from '@relay/domain';
import { Badge, Banner, Button, Card, describedBy, Field, SampleBadge } from '@relay/ui';
import { useToast } from '@relay/ui/client';
import { ApiError, apiFetch, errorMessage } from '@/lib/client/api';
import { CaptionEditor, withCueKeys, type CueErrors, type EditorCue } from './CaptionEditor';
import { CropPreview, describeGeometry } from './CropPreview';
import { usePlayer, useSignedVideoUrl } from './media';
import { RenderPanel, type HandoffDestination } from './RenderPanel';
import {
  clampMs,
  formatLength,
  formatTimecode,
  snapMs,
  spokenTimecode,
  TIME_STEP_MS,
} from './time';
import { TimecodeField } from './TimecodeField';
import { TrimBar } from './TrimBar';
import type { CandidatesResponse, WireClipDetail, WireClipRender } from './types';

const ASPECT_LABELS: Record<ClipAspect, string> = {
  '9:16': '9:16 · vertical',
  '1:1': '1:1 · square',
  original: 'Original shape',
};

interface Draft {
  title: string;
  startMs: number;
  endMs: number;
  aspect: ClipAspect;
  cropMode: ClipCropMode;
}

const draftOf = (detail: Pick<WireClipDetail, 'clip' | 'revision'>): Draft => ({
  title: detail.clip.title,
  startMs: detail.revision.startMs,
  endMs: detail.revision.endMs,
  aspect: detail.revision.aspect,
  cropMode: detail.revision.cropMode,
});

const plainCues = (cues: readonly EditorCue[]) =>
  cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));

/** Field by field: the stored cues come back with their keys in the database's order. */
const sameCues = (a: readonly Cue[], b: readonly Cue[]) =>
  a.length === b.length &&
  a.every((cue, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      cue.startMs === other.startMs &&
      cue.endMs === other.endMs &&
      cue.text === other.text
    );
  });

/** The stretch of the source the trim bar shows when it is zoomed to the clip. */
function clipView(startMs: number, endMs: number, durationMs: number) {
  const pad = Math.max(5000, Math.round((endMs - startMs) / 2));
  return { fromMs: Math.max(0, startMs - pad), toMs: Math.min(durationMs, endMs + pad) };
}

/**
 * The clip editor: range, shape and captions of one clip, previewed on the source proxy with
 * the renderer's own geometry. Saving writes a new revision guarded by the clip's version;
 * rendering and the hand-off to a draft post follow in the panel below.
 */
export function ClipEditor({
  slug,
  workspaceId,
  initial,
  pageName,
  perms,
  clipMaxMs,
  destinations,
}: {
  slug: string;
  workspaceId: string;
  initial: WireClipDetail;
  pageName: string | null;
  perms: { edit: boolean; create: boolean; export: boolean };
  clipMaxMs: number;
  destinations: HandoffDestination[];
}) {
  const toast = useToast();
  const ids = useId();
  const clipUrl = `/api/v1/workspaces/${workspaceId}/clips/${initial.clip.id}`;
  const source = initial.source;
  const durationMs = source.durationMs ?? 0;

  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [cues, setCues] = useState<EditorCue[]>(() => withCueKeys(initial.revision.captions));
  const [serverErrors, setServerErrors] = useState<Record<string, string[]> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [showCueErrors, setShowCueErrors] = useState(false);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [envelopeState, setEnvelopeState] = useState<'loading' | 'ready' | 'none'>('loading');
  const [view, setView] = useState(() =>
    durationMs > 120_000
      ? clipView(initial.revision.startMs, initial.revision.endMs, durationMs)
      : { fromMs: 0, toMs: durationMs },
  );
  const [videoFailed, setVideoFailed] = useState(false);

  const {
    ref: videoRef,
    playheadMs: playhead,
    playing,
    seek,
    play,
    pause,
  } = usePlayer({ startMs: draft.startMs, endMs: draft.endMs }, 'loop');
  const video = useSignedVideoUrl(workspaceId, source.id);
  const playheadRef = useRef(0);
  useEffect(() => {
    playheadRef.current = playhead;
  });

  // The loudness envelope belongs to the source's newest analysis; without one the bar is plain.
  useEffect(() => {
    const controller = new AbortController();
    apiFetch<CandidatesResponse>(
      `/api/v1/workspaces/${workspaceId}/assets/${source.id}/candidates`,
      { signal: controller.signal },
    )
      .then((result) => {
        setEnvelope(result.analysis?.envelope ?? null);
        setEnvelopeState(result.analysis?.envelope ? 'ready' : 'none');
      })
      .catch(() => {
        if (!controller.signal.aborted) setEnvelopeState('none');
      });
    return () => controller.abort();
  }, [workspaceId, source.id]);

  const dirty = useMemo(() => {
    const revision = saved.revision;
    return (
      draft.title.trim() !== saved.clip.title ||
      draft.startMs !== revision.startMs ||
      draft.endMs !== revision.endMs ||
      draft.aspect !== revision.aspect ||
      draft.cropMode !== revision.cropMode ||
      !sameCues(cues, revision.captions ?? [])
    );
  }, [draft, cues, saved]);

  // Leaving with unsaved work asks first; the browser shows its own wording.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const rangeCheck = useMemo(
    () =>
      durationMs > 0
        ? validateClipRange({
            startMs: draft.startMs,
            endMs: draft.endMs,
            sourceDurationMs: durationMs,
            minMs: CLIP_MIN_MS,
            maxMs: clipMaxMs,
          })
        : null,
    [draft.startMs, draft.endMs, durationMs, clipMaxMs],
  );
  const cueCheck = useMemo(
    () => validateCues(plainCues(cues), { clipStartMs: draft.startMs, clipEndMs: draft.endMs }),
    [cues, draft.startMs, draft.endMs],
  );
  const { cueErrors, trackError } = useMemo(() => {
    const merged: Record<string, string[]> = {
      ...(showCueErrors && !cueCheck.ok ? cueCheck.fieldErrors : {}),
      ...(serverErrors ?? {}),
    };
    const byCue: CueErrors = {};
    for (const [field, messages] of Object.entries(merged)) {
      const match = /^captions\.(\d+)\.(startMs|endMs|text)$/.exec(field);
      if (!match) continue;
      const index = Number(match[1]);
      byCue[index] = { ...byCue[index], [match[2] as 'startMs' | 'endMs' | 'text']: messages[0] };
    }
    return { cueErrors: byCue, trackError: merged.captions?.[0] ?? null };
  }, [cueCheck, serverErrors, showCueErrors]);

  const geometry = useMemo(
    () =>
      source.width && source.height && source.width >= 2 && source.height >= 2
        ? clipGeometry({
            sourceWidth: source.width,
            sourceHeight: source.height,
            aspect: draft.aspect,
            cropMode: draft.cropMode,
          })
        : null,
    [source.width, source.height, draft.aspect, draft.cropMode],
  );

  const activeCaption =
    playhead >= draft.startMs && playhead < draft.endMs
      ? (cues.find((cue) => playhead >= cue.startMs && playhead < cue.endMs)?.text ?? null)
      : null;

  const editRange = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setServerErrors(null);
    setSaveError(null);
  };
  const changeCues = useCallback((next: EditorCue[]) => {
    setCues(next);
    setServerErrors(null);
    setSaveError(null);
  }, []);
  const getPlayheadMs = useCallback(() => playheadRef.current, []);
  const previewCue = useCallback(
    (ms: number) => {
      seek(ms);
      play();
    },
    [seek, play],
  );

  function reset(detail: WireClipDetail) {
    setSaved(detail);
    setDraft(draftOf(detail));
    setCues(withCueKeys(detail.revision.captions));
    setServerErrors(null);
    setSaveError(null);
    setShowCueErrors(false);
    setConflict(false);
  }

  async function reload() {
    setReloading(true);
    try {
      reset(await apiFetch<WireClipDetail>(clipUrl));
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setReloading(false);
    }
  }

  async function save(): Promise<boolean> {
    setShowCueErrors(true);
    const title = draft.title.trim();
    if (!rangeCheck?.ok || !cueCheck.ok || title === '') {
      setSaveError('Fix the fields marked above, then save again.');
      return false;
    }
    setSaving(true);
    setSaveError(null);
    setServerErrors(null);
    try {
      const result = await apiFetch<{
        clip: WireClipDetail['clip'];
        revision: WireClipDetail['revision'];
        revisionCreated: boolean;
      }>(clipUrl, {
        method: 'PATCH',
        body: {
          version: saved.clip.version,
          title,
          startMs: draft.startMs,
          endMs: draft.endMs,
          aspect: draft.aspect,
          cropMode: draft.cropMode,
          captions: cues.length > 0 ? plainCues(cues) : null,
        },
      });
      let latestRender = saved.latestRender;
      if (result.revisionCreated) {
        // Which render belongs to the new revision is the server's call (an edit that returns
        // to an earlier state reuses that state's render).
        try {
          latestRender = (await apiFetch<WireClipDetail>(clipUrl)).latestRender;
        } catch {
          latestRender = saved.latestRender;
        }
      }
      reset({ ...saved, clip: result.clip, revision: result.revision, latestRender });
      toast(
        'success',
        result.revisionCreated
          ? `Saved as revision ${result.revision.revisionNumber}`
          : 'Saved. The picture is unchanged, so no new revision was needed.',
      );
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setConflict(true);
      } else {
        if (error instanceof ApiError && error.fieldErrors) setServerErrors(error.fieldErrors);
        setSaveError(errorMessage(error));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  const refreshRender = useCallback(
    async (signal?: AbortSignal) => {
      const detail = await apiFetch<WireClipDetail>(clipUrl, signal ? { signal } : {});
      setSaved((current) => ({ ...current, latestRender: detail.latestRender }));
      return detail;
    },
    [clipUrl],
  );
  const renderStarted = useCallback(
    (render: WireClipRender) => setSaved((current) => ({ ...current, latestRender: render })),
    [],
  );

  const readOnly = !perms.edit || conflict;
  const startError =
    serverErrors?.startMs?.[0] ??
    (rangeCheck && !rangeCheck.ok ? rangeCheck.fieldErrors.startMs?.[0] : null);
  const endError =
    serverErrors?.endMs?.[0] ??
    (rangeCheck && !rangeCheck.ok ? rangeCheck.fieldErrors.endMs?.[0] : null);
  const titleError =
    serverErrors?.title?.[0] ?? (draft.title.trim() === '' ? 'Give the clip a title' : null);
  const shownView = {
    fromMs: Math.min(view.fromMs, draft.startMs),
    toMs: Math.max(view.toMs, draft.endMs),
  };
  const wholeVideo = shownView.fromMs === 0 && shownView.toMs === durationMs;

  const header = (
    <div className="app-page-header">
      <div className="r-stack-sm" style={{ minWidth: 0 }}>
        <Link href={`/w/${slug}/find-clips/${source.id}`} className="r-small back-link">
          <ArrowLeft aria-hidden width={16} height={16} /> {source.originalFilename}
        </Link>
        <h1 className="page-title-wrap">{saved.clip.title}</h1>
        <p className="r-row-tight">
          <span>
            Revision {saved.revision.revisionNumber}
            {pageName ? ` · ${pageName}` : ''}
          </span>
          {source.isSample ? <SampleBadge /> : null}
        </p>
      </div>
      <div className="r-row-tight">
        {dirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge>Saved</Badge>}
      </div>
    </div>
  );

  if (durationMs <= 0 || source.status !== 'ready') {
    return (
      <>
        {header}
        <Banner tone="warning" title="The source video is not available">
          The video this clip was cut from is no longer ready, so the clip cannot be edited or
          rendered.
        </Banner>
      </>
    );
  }

  return (
    <>
      {header}
      {!perms.edit ? (
        <Banner tone="info" title="You can view this clip">
          Your role cannot change clips. Ask an editor to make changes.
        </Banner>
      ) : null}
      {conflict ? (
        <Banner tone="warning" live title="Someone else edited this clip">
          <p>
            Your changes were not saved, because they were made on an older version. Load the latest
            version to continue; your unsaved changes on this screen will be replaced.
          </p>
          <p style={{ marginTop: 'var(--space-2)' }}>
            <Button busy={reloading} onClick={reload}>
              Load the latest version
            </Button>
          </p>
        </Banner>
      ) : null}

      <div className="clip-editor">
        <section className="clip-editor__stage r-stack" aria-labelledby={`${ids}-preview`}>
          <h2 id={`${ids}-preview`} className="r-visually-hidden">
            Preview
          </h2>
          {geometry ? (
            <CropPreview
              geometry={geometry}
              videoRef={videoRef}
              src={video.url}
              label={`Preview of ${saved.clip.title}`}
              caption={activeCaption}
              onVideoError={() => {
                if (video.url && !video.refresh()) setVideoFailed(true);
              }}
            />
          ) : (
            <Banner tone="warning" title="The picture size of the source is unknown">
              The framing cannot be previewed. You can still change the range and the captions.
            </Banner>
          )}
          {video.error || videoFailed ? (
            <Banner tone="warning" live title="The preview cannot be played">
              {video.error ?? 'The video did not load. Reload the page to try again.'}
            </Banner>
          ) : null}
          <div className="r-spread">
            <div className="r-row-tight">
              <Button
                variant="primary"
                icon={playing ? <Pause aria-hidden /> : <Play aria-hidden />}
                onClick={() => (playing ? pause() : play())}
              >
                {playing ? 'Pause' : 'Play clip'}
              </Button>
              <Button
                icon={<RotateCcw aria-hidden />}
                aria-label="Play from the start of the clip"
                onClick={() => previewCue(draft.startMs)}
              />
            </div>
            <span className="r-small r-tabular">
              {formatTimecode(playhead)}
              <span className="r-muted"> · clip {formatLength(draft.endMs - draft.startMs)}</span>
            </span>
          </div>
          {geometry ? (
            <p className="r-xs r-muted">
              {describeGeometry(geometry)} The preview loops inside the range and uses the same
              framing numbers as the renderer; caption line breaks can differ slightly.
            </p>
          ) : null}
        </section>

        <div className="clip-editor__controls r-stack-lg">
          <Card className="r-stack" aria-labelledby={`${ids}-range`}>
            <div className="r-spread">
              <h2 id={`${ids}-range`}>Range</h2>
              <div className="r-row-tight">
                <Button
                  variant="ghost"
                  icon={<ZoomIn aria-hidden />}
                  onClick={() => setView(clipView(draft.startMs, draft.endMs, durationMs))}
                >
                  Zoom to clip
                </Button>
                <Button
                  variant="ghost"
                  icon={<ZoomOut aria-hidden />}
                  disabled={wholeVideo}
                  onClick={() => setView({ fromMs: 0, toMs: durationMs })}
                >
                  Whole video
                </Button>
              </div>
            </div>
            <TrimBar
              durationMs={durationMs}
              view={shownView}
              startMs={draft.startMs}
              endMs={draft.endMs}
              minMs={CLIP_MIN_MS}
              playheadMs={playhead}
              envelope={envelope}
              disabled={readOnly}
              onStart={(ms) => editRange({ startMs: ms })}
              onEnd={(ms) => editRange({ endMs: ms })}
              onSeek={seek}
            />
            <label className="playhead-slider">
              <span className="r-xs r-muted">Playhead</span>
              <input
                type="range"
                min={shownView.fromMs}
                max={shownView.toMs}
                step={TIME_STEP_MS}
                value={clampMs(playhead, shownView.fromMs, shownView.toMs)}
                aria-valuetext={spokenTimecode(playhead)}
                onChange={(e) => seek(Number(e.target.value))}
              />
            </label>
            <p className="r-xs r-muted">
              {envelopeState === 'ready'
                ? 'The outline shows how loud the video is over time.'
                : envelopeState === 'loading'
                  ? 'Loading the loudness outline.'
                  : source.hasAudio === false
                    ? 'This video has no audio, so there is no loudness outline.'
                    : 'No loudness outline yet: it appears once the video has been analysed.'}{' '}
              Drag the two handles, or focus one and use the arrow keys (0.1 s; with Shift 1 s).
            </p>
            <div className="range-fields">
              <div className="r-stack-sm">
                <TimecodeField
                  id={`${ids}-start`}
                  label="Start"
                  valueMs={draft.startMs}
                  disabled={readOnly}
                  error={startError ?? null}
                  onCommit={(ms) => editRange({ startMs: clampMs(ms, 0, durationMs) })}
                />
                <Button
                  disabled={readOnly}
                  onClick={() =>
                    editRange({
                      startMs: clampMs(snapMs(playhead), 0, draft.endMs - CLIP_MIN_MS),
                    })
                  }
                >
                  Set start to playhead
                </Button>
              </div>
              <div className="r-stack-sm">
                <TimecodeField
                  id={`${ids}-end`}
                  label="End"
                  valueMs={draft.endMs}
                  disabled={readOnly}
                  error={endError ?? null}
                  onCommit={(ms) => editRange({ endMs: clampMs(ms, 0, durationMs) })}
                />
                <Button
                  disabled={readOnly}
                  onClick={() =>
                    editRange({
                      endMs: clampMs(snapMs(playhead), draft.startMs + CLIP_MIN_MS, durationMs),
                    })
                  }
                >
                  Set end to playhead
                </Button>
              </div>
            </div>
            <p className="r-small r-tabular" aria-live="polite">
              Clip length {formatLength(draft.endMs - draft.startMs)} of a{' '}
              {formatLength(durationMs)} video. Longest allowed: {formatLength(clipMaxMs)}.
            </p>
          </Card>

          <Card className="r-stack" aria-labelledby={`${ids}-shape`}>
            <h2 id={`${ids}-shape`}>Shape</h2>
            <Field id={`${ids}-aspect`} label="Aspect ratio">
              <select
                id={`${ids}-aspect`}
                className="r-select"
                value={draft.aspect}
                disabled={readOnly}
                onChange={(e) => editRange({ aspect: e.target.value as ClipAspect })}
              >
                {CLIP_ASPECTS.map((aspect) => (
                  <option key={aspect} value={aspect}>
                    {ASPECT_LABELS[aspect]}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset
              className="r-fieldset r-stack-sm"
              disabled={readOnly || draft.aspect === 'original'}
            >
              <legend>How the picture fills the frame</legend>
              <label className="r-check">
                <input
                  type="radio"
                  name={`${ids}-crop`}
                  checked={draft.cropMode === 'fill'}
                  onChange={() => editRange({ cropMode: 'fill' })}
                />
                <span className="r-small">
                  <strong>Fill</strong>: the frame is filled and the edges of the picture are
                  cropped.
                </span>
              </label>
              <label className="r-check">
                <input
                  type="radio"
                  name={`${ids}-crop`}
                  checked={draft.cropMode === 'fit'}
                  onChange={() => editRange({ cropMode: 'fit' })}
                />
                <span className="r-small">
                  <strong>Fit</strong>: the whole picture is kept and bars fill the rest.
                </span>
              </label>
              {draft.aspect === 'original' ? (
                <p className="r-xs r-muted">
                  The original shape keeps the whole picture, so there is nothing to choose.
                </p>
              ) : null}
            </fieldset>
          </Card>

          <Card className="r-stack" aria-labelledby={`${ids}-captions`}>
            <h2 id={`${ids}-captions`}>Captions</h2>
            <CaptionEditor
              workspaceId={workspaceId}
              clipId={saved.clip.id}
              cues={cues}
              errors={cueErrors}
              trackError={trackError}
              clipStartMs={draft.startMs}
              clipEndMs={draft.endMs}
              disabled={readOnly}
              onChange={changeCues}
              getPlayheadMs={getPlayheadMs}
              onPreviewCue={previewCue}
            />
          </Card>

          <Card className="r-stack" aria-labelledby={`${ids}-save`}>
            <h2 id={`${ids}-save`}>Title and save</h2>
            <Field
              id={`${ids}-title`}
              label="Clip title"
              hint="Used as the title of the draft post. Renaming does not need a new render."
              error={titleError}
            >
              <input
                id={`${ids}-title`}
                className="r-input"
                value={draft.title}
                maxLength={120}
                disabled={readOnly}
                aria-invalid={titleError ? 'true' : undefined}
                aria-describedby={describedBy(`${ids}-title`, { hint: true, error: titleError })}
                onChange={(e) => editRange({ title: e.target.value })}
              />
            </Field>
            {saveError ? (
              <Banner tone="danger" live title="The clip was not saved">
                {saveError}
              </Banner>
            ) : null}
            {perms.edit ? (
              <div className="r-row-tight">
                <Button
                  variant={dirty ? 'primary' : 'secondary'}
                  icon={<Save aria-hidden />}
                  busy={saving}
                  disabled={!dirty || conflict}
                  onClick={() => void save()}
                >
                  Save clip
                </Button>
                <Button
                  variant="ghost"
                  disabled={!dirty || saving || conflict}
                  onClick={() => reset(saved)}
                >
                  Discard changes
                </Button>
              </div>
            ) : null}
          </Card>

          <RenderPanel
            slug={slug}
            workspaceId={workspaceId}
            clipId={saved.clip.id}
            currentRevisionId={saved.clip.currentRevisionId}
            render={saved.latestRender}
            dirty={dirty}
            canSave={perms.edit && !conflict}
            perms={{ create: perms.create, export: perms.export }}
            destinations={destinations}
            onSaveFirst={save}
            onRenderStarted={renderStarted}
            onRefresh={refreshRender}
          />
        </div>
      </div>
    </>
  );
}
