'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import {
  CircleCheck,
  Play,
  RefreshCw,
  Scissors,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sparkles,
} from 'lucide-react';
import { CLIP_MIN_MS, validateClipRange, type CandidateFeedback } from '@relay/domain';
import { Badge, Banner, Button, Card, ProgressBar, Spinner } from '@relay/ui';
import { apiFetch, errorMessage, newIdempotencyKey, poll } from '@/lib/client/api';
import { usePlayer, useSignedVideoUrl, type PlayerRange } from './media';
import { clampMs, formatLength, formatTimecode, snapMs, spokenTimecode } from './time';
import { TimecodeField } from './TimecodeField';
import type {
  CandidatesResponse,
  JobResponse,
  StartAnalysisResult,
  WireAnalysis,
  WireCandidate,
  WireClipSummary,
} from './types';

interface SourceInfo {
  id: string;
  originalFilename: string;
  durationMs: number;
  hasAudio: boolean | null;
}

const FEEDBACK_OPTIONS: Array<{ value: CandidateFeedback; label: string }> = [
  { value: 'accepted', label: 'Good pick' },
  { value: 'missing_context', label: 'Missing context' },
  { value: 'wrong_fit', label: 'Wrong fit' },
  { value: 'rights_issue', label: 'Rights issue' },
];

const ANALYSIS_FAILURES: Record<string, string> = {
  rights_missing: 'The rights recorded for this video do not allow editing it.',
  media_not_ready: 'The video was not ready to be read.',
  source_changed: 'The video changed while it was being analysed.',
  unsupported_aspect: 'This video is too wide or too tall to analyse.',
  input_unavailable: 'The stored video could not be read.',
  processing_failed: 'The video could not be processed.',
};

const inFlight = (analysis: WireAnalysis | null): boolean =>
  analysis !== null && (analysis.status === 'queued' || analysis.status === 'running');

/** Confidence in words, with its own icon so the three levels differ without colour. */
function confidenceOf(confidence: number) {
  if (confidence >= 0.66)
    return {
      label: 'High confidence',
      tone: 'success' as const,
      icon: <SignalHigh aria-hidden />,
      note: 'The signals clearly stand out from the rest of the video.',
    };
  if (confidence >= 0.33)
    return {
      label: 'Medium confidence',
      tone: 'info' as const,
      icon: <SignalMedium aria-hidden />,
      note: 'The signals stand out, but not strongly. Worth a look.',
    };
  return {
    label: 'Low confidence',
    tone: 'neutral' as const,
    icon: <SignalLow aria-hidden />,
    note: 'Only a weak signal. Check it before you use it.',
  };
}

/**
 * One source video: analysis progress, then the ranked suggestions with their reasons, a
 * preview player on the proxy, feedback, and a manual range as the way in when the analysis
 * found nothing or the editor knows better.
 */
export function SourceWorkspace({
  slug,
  workspaceId,
  source,
  perms,
  clipMaxMs,
}: {
  slug: string;
  workspaceId: string;
  source: SourceInfo;
  perms: { create: boolean; edit: boolean };
  clipMaxMs: number;
}) {
  const router = useRouter();
  const ids = useId();
  const base = `/api/v1/workspaces/${workspaceId}`;
  const candidatesUrl = `${base}/assets/${source.id}/candidates`;

  const [data, setData] = useState<CandidatesResponse | null>(null);
  const [clips, setClips] = useState<WireClipSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [checkNonce, setCheckNonce] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);

  const [previewRange, setPreviewRange] = useState<(PlayerRange & { label: string }) | null>(null);
  const { ref: videoRef, playheadMs, play, pause } = usePlayer(previewRange, 'stop');
  const video = useSignedVideoUrl(workspaceId, source.id);
  const [videoFailed, setVideoFailed] = useState(false);

  const [manualStart, setManualStart] = useState(0);
  const [manualEnd, setManualEnd] = useState(() =>
    Math.min(source.durationMs, clipMaxMs, Math.max(CLIP_MIN_MS, 15_000)),
  );
  const manual = validateClipRange({
    startMs: manualStart,
    endMs: manualEnd,
    sourceDurationMs: source.durationMs,
    minMs: CLIP_MIN_MS,
    maxMs: clipMaxMs,
  });

  // First load: the newest analysis with its suggestions, and the clips already cut from this
  // video. Both are read through the API so the page itself needs one service call.
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [candidates, existing] = await Promise.all([
          apiFetch<CandidatesResponse>(candidatesUrl, { signal: controller.signal }),
          apiFetch<{ clips: WireClipSummary[] }>(`${base}/clips?sourceAssetId=${source.id}`, {
            signal: controller.signal,
          }).catch(() => ({ clips: [] })),
        ]);
        setData(candidates);
        setClips(existing.clips);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      }
    };
    void load();
    return () => controller.abort();
  }, [base, candidatesUrl, source.id]);

  // While an analysis is queued or running, follow its job (or, without one, the analysis
  // itself) with bounded backoff, then load the suggestions once.
  const analysis = data?.analysis ?? null;
  const pollingId = inFlight(analysis) ? analysis!.id : null;
  const jobUrl = data?.jobUrl ?? null;
  useEffect(() => {
    if (!pollingId) return;
    const controller = new AbortController();
    const options = {
      initialMs: 1000,
      maxMs: 4000,
      timeoutMs: 20 * 60_000,
      signal: controller.signal,
    };
    const follow = async () => {
      try {
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
        } else {
          await poll(
            () => apiFetch<CandidatesResponse>(candidatesUrl, { signal: controller.signal }),
            (r) => !inFlight(r.analysis),
            options,
          );
        }
        const fresh = await apiFetch<CandidatesResponse>(candidatesUrl, {
          signal: controller.signal,
        });
        setData(fresh);
        if (inFlight(fresh.analysis)) {
          setStalled(true);
        } else if (fresh.analysis?.status === 'failed') {
          setAnnouncement('The analysis failed.');
        } else {
          const n = fresh.candidates.length;
          setAnnouncement(
            n > 0
              ? `Analysis finished. ${n} suggestion${n === 1 ? '' : 's'} found.`
              : 'Analysis finished. No clear highlights were found.',
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setStalled(true);
          setActionError({ key: 'poll', message: errorMessage(error) });
        }
      }
    };
    void follow();
    return () => controller.abort();
  }, [pollingId, jobUrl, candidatesUrl, checkNonce]);

  async function startAnalysis() {
    setBusy('analyse');
    setActionError(null);
    try {
      const started = await apiFetch<StartAnalysisResult>(`${base}/assets/${source.id}/analyses`, {
        body: {},
      });
      setProgress(0);
      setStalled(false);
      setData({
        analysis: started.analysis,
        jobId: started.jobId,
        jobUrl: started.jobUrl,
        candidates: [],
      });
      if (inFlight(started.analysis)) {
        setAnnouncement('Analysis started.');
      } else {
        // An earlier analysis already finished: show its suggestions.
        setData(await apiFetch<CandidatesResponse>(candidatesUrl));
      }
    } catch (error) {
      setActionError({ key: 'analyse', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function createClip(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      const created = await apiFetch<{ clipId: string }>(`${base}/clips`, {
        body: { sourceAssetId: source.id, ...body },
        idempotencyKey: newIdempotencyKey('clip'),
      });
      router.push(`/w/${slug}/clips/${created.clipId}`);
    } catch (error) {
      setActionError({ key, message: errorMessage(error) });
      setBusy(null);
    }
  }

  async function sendFeedback(candidate: WireCandidate, feedback: CandidateFeedback) {
    const key = `feedback:${candidate.id}`;
    setBusy(key);
    setActionError(null);
    try {
      const result = await apiFetch<{ candidate: WireCandidate }>(
        `${base}/candidates/${candidate.id}/feedback`,
        { body: { feedback } },
      );
      setData((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates.map((c) =>
                c.id === candidate.id ? result.candidate : c,
              ),
            }
          : current,
      );
      setAnnouncement(`Feedback saved for suggestion ${candidate.rank}.`);
    } catch (error) {
      setActionError({ key, message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  function preview(range: PlayerRange, label: string) {
    setPreviewRange({ ...range, label });
    play(range);
    // On a narrow screen the player sits above the list: bring it back into view.
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    videoRef.current?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
  }

  const candidates = data?.candidates ?? [];
  const noSignal =
    analysis?.status === 'succeeded' && (analysis.summary?.noSignal || candidates.length === 0);
  const errorFor = (key: string) => (actionError?.key === key ? actionError.message : null);

  return (
    <div className="clip-source-layout">
      <p className="r-visually-hidden" role="status">
        {announcement}
      </p>

      <div className="clip-source-layout__player">
        <Card className="r-stack">
          <h2>Preview</h2>
          <div className="clip-player">
            <video
              ref={videoRef}
              src={video.url ?? undefined}
              controls
              playsInline
              preload="metadata"
              aria-label={`Preview of ${source.originalFilename}`}
              onError={() => {
                if (video.url && !video.refresh()) setVideoFailed(true);
              }}
            />
          </div>
          {video.error || videoFailed ? (
            <Banner tone="warning" live title="The preview cannot be played">
              {video.error ?? 'The video did not load. Reload the page to try again.'}
            </Banner>
          ) : null}
          <p className="r-small r-muted r-tabular">
            {previewRange
              ? `${previewRange.label}: ${formatTimecode(previewRange.startMs)} to ${formatTimecode(previewRange.endMs)}. Playback stops at the end of the range.`
              : `Whole video · ${formatTimecode(source.durationMs)} · playhead ${formatTimecode(playheadMs)}`}
          </p>
          {previewRange ? (
            <div>
              <Button
                variant="ghost"
                onClick={() => {
                  setPreviewRange(null);
                  pause();
                }}
              >
                Back to the whole video
              </Button>
            </div>
          ) : null}
        </Card>
      </div>

      <div className="r-stack-lg clip-source-layout__main">
        <section className="r-stack" aria-labelledby={`${ids}-suggestions`}>
          <div className="r-spread">
            <h2 id={`${ids}-suggestions`}>Suggested clips</h2>
            {analysis?.status === 'succeeded' ? (
              <span className="r-xs r-muted">Ranked by {analysis.rankerVersion}</span>
            ) : null}
          </div>

          {loadError ? (
            <Banner tone="danger" live title="The suggestions could not be loaded">
              {loadError}
            </Banner>
          ) : data === null ? (
            <Spinner label="Loading suggestions" />
          ) : analysis === null ? (
            <Card flat className="r-stack">
              <p className="r-small">
                This video has not been analysed yet. The analysis listens for loud moments and
                looks for scene changes, then suggests ranges and tells you why. It runs inside
                Relay and sends nothing to any platform.
              </p>
              {perms.create ? (
                <div>
                  <Button
                    variant="primary"
                    icon={<Sparkles aria-hidden />}
                    busy={busy === 'analyse'}
                    onClick={startAnalysis}
                  >
                    Analyse this video
                  </Button>
                </div>
              ) : (
                <p className="r-small r-muted">Your role cannot start an analysis.</p>
              )}
            </Card>
          ) : inFlight(analysis) ? (
            <Card flat className="r-stack">
              <ProgressBar value={Math.max(progress, 3)} label="Analysing the video" />
              <p className="r-small" role="status">
                {stalled
                  ? 'This is taking longer than expected. The analysis may still be running.'
                  : analysis.status === 'queued' && progress === 0
                    ? 'Waiting for a worker to pick up the analysis.'
                    : 'Analysing the sound and the picture. You can leave this page; the result is kept.'}
              </p>
              {stalled ? (
                <div>
                  <Button
                    icon={<RefreshCw aria-hidden />}
                    onClick={() => {
                      setStalled(false);
                      setActionError(null);
                      setCheckNonce((n) => n + 1);
                    }}
                  >
                    Check again
                  </Button>
                </div>
              ) : null}
            </Card>
          ) : analysis.status === 'failed' ? (
            <Banner tone="danger" title="The analysis failed">
              <p>
                {ANALYSIS_FAILURES[analysis.errorCode ?? ''] ??
                  'Something went wrong while analysing this video.'}{' '}
                You can still create a clip from a manual range below.
              </p>
              {perms.create ? (
                <p style={{ marginTop: 'var(--space-2)' }}>
                  <Button
                    icon={<RefreshCw aria-hidden />}
                    busy={busy === 'analyse'}
                    onClick={startAnalysis}
                  >
                    Analyse again
                  </Button>
                </p>
              ) : null}
            </Banner>
          ) : noSignal ? (
            <Banner tone="info" title="No clear highlights were found">
              {source.hasAudio === false
                ? 'This video has no audio and no scene changes to go on.'
                : 'Nothing in the sound or the picture stood out from the rest of the video.'}{' '}
              <a href={`#${ids}-manual`}>Create a clip from a manual range</a> instead.
            </Banner>
          ) : (
            <ol className="candidate-list">
              {candidates.map((candidate) => {
                const confidence = confidenceOf(candidate.confidence);
                const range = { startMs: candidate.startMs, endMs: candidate.endMs };
                const active =
                  previewRange?.startMs === candidate.startMs &&
                  previewRange.endMs === candidate.endMs;
                const feedbackKey = `feedback:${candidate.id}`;
                const editKey = `edit:${candidate.id}`;
                return (
                  <li
                    key={candidate.id}
                    className="r-card candidate"
                    data-active={active ? 'true' : 'false'}
                  >
                    <div className="r-spread">
                      <div className="r-row-tight">
                        <span className="candidate__rank r-tabular" aria-hidden>
                          {candidate.rank}
                        </span>
                        <h3>
                          <span className="r-visually-hidden">Suggestion {candidate.rank}: </span>
                          <span className="r-tabular">
                            {formatTimecode(candidate.startMs)} – {formatTimecode(candidate.endMs)}
                          </span>
                        </h3>
                        <span className="r-small r-muted r-tabular">
                          {formatLength(candidate.endMs - candidate.startMs)}
                        </span>
                      </div>
                      <div className="r-row-tight">
                        <Badge>Suggested</Badge>
                        <Badge tone={confidence.tone} icon={confidence.icon}>
                          {confidence.label}
                        </Badge>
                      </div>
                    </div>
                    <p>{candidate.reason}</p>
                    <p className="r-small r-muted">
                      Score {Math.round(candidate.score * 100)} out of 100. {confidence.note}
                    </p>
                    <div className="r-row-tight">
                      <Button
                        icon={<Play aria-hidden />}
                        aria-label={`Preview suggestion ${candidate.rank}, from ${spokenTimecode(candidate.startMs)} to ${spokenTimecode(candidate.endMs)}`}
                        onClick={() => preview(range, `Suggestion ${candidate.rank}`)}
                      >
                        Preview
                      </Button>
                      {perms.create ? (
                        <Button
                          variant="primary"
                          icon={<Scissors aria-hidden />}
                          busy={busy === editKey}
                          disabled={busy !== null && busy !== editKey}
                          aria-label={`Edit suggestion ${candidate.rank} as a clip`}
                          onClick={() => createClip(editKey, { candidateId: candidate.id })}
                        >
                          Edit clip
                        </Button>
                      ) : null}
                    </div>
                    {errorFor(editKey) ? (
                      <Banner tone="danger" live>
                        {errorFor(editKey)}
                      </Banner>
                    ) : null}
                    {perms.edit ? (
                      <div
                        className="candidate__feedback"
                        role="group"
                        aria-label={`Feedback on suggestion ${candidate.rank}`}
                      >
                        <span className="r-xs r-muted">Was this a good suggestion?</span>
                        <div className="r-row-tight">
                          {FEEDBACK_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className="feedback-chip"
                              aria-pressed={candidate.feedback === option.value}
                              disabled={busy === feedbackKey}
                              onClick={() => {
                                if (candidate.feedback !== option.value)
                                  void sendFeedback(candidate, option.value);
                              }}
                            >
                              {candidate.feedback === option.value ? (
                                <CircleCheck aria-hidden width={14} height={14} />
                              ) : null}
                              {option.label}
                            </button>
                          ))}
                        </div>
                        {candidate.feedback === 'trim_adjusted' ? (
                          <span className="r-xs r-muted">
                            Recorded: the range was adjusted in the editor.
                          </span>
                        ) : null}
                        {errorFor(feedbackKey) ? (
                          <span className="r-error-text" role="alert">
                            {errorFor(feedbackKey)}
                          </span>
                        ) : null}
                      </div>
                    ) : candidate.feedback ? (
                      <span className="r-xs r-muted">Feedback recorded.</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {errorFor('analyse') ? (
            <Banner tone="danger" live title="The analysis could not be started">
              {errorFor('analyse')}
            </Banner>
          ) : null}
          {errorFor('poll') ? (
            <Banner tone="warning" live title="Progress could not be checked">
              {errorFor('poll')}
            </Banner>
          ) : null}
        </section>

        {perms.create ? (
          <Card className="r-stack" aria-labelledby={`${ids}-manual`}>
            <h2 id={`${ids}-manual`} tabIndex={-1}>
              Create a clip from a manual range
            </h2>
            <p className="r-small r-muted">
              Type the start and end, or move the preview to the right moment and use the playhead
              buttons. You can fine-tune the range in the editor.
            </p>
            <div className="range-fields">
              <div className="r-stack-sm">
                <TimecodeField
                  id={`${ids}-manual-start`}
                  label="Start"
                  valueMs={manualStart}
                  onCommit={(ms) => setManualStart(clampMs(ms, 0, source.durationMs))}
                  error={manual.ok ? null : (manual.fieldErrors.startMs?.[0] ?? null)}
                />
                <Button
                  onClick={() => setManualStart(clampMs(snapMs(playheadMs), 0, source.durationMs))}
                >
                  Set start to playhead
                </Button>
              </div>
              <div className="r-stack-sm">
                <TimecodeField
                  id={`${ids}-manual-end`}
                  label="End"
                  valueMs={manualEnd}
                  onCommit={(ms) => setManualEnd(clampMs(ms, 0, source.durationMs))}
                  error={manual.ok ? null : (manual.fieldErrors.endMs?.[0] ?? null)}
                />
                <Button
                  onClick={() => setManualEnd(clampMs(snapMs(playheadMs), 0, source.durationMs))}
                >
                  Set end to playhead
                </Button>
              </div>
            </div>
            <p className="r-small r-tabular" aria-live="polite">
              {manual.ok
                ? `Clip length ${formatLength(manual.durationMs)}.`
                : 'Fix the range to continue.'}
            </p>
            <div className="r-row-tight">
              <Button
                icon={<Play aria-hidden />}
                disabled={!manual.ok}
                onClick={() => preview({ startMs: manualStart, endMs: manualEnd }, 'Manual range')}
              >
                Preview range
              </Button>
              <Button
                variant="primary"
                icon={<Scissors aria-hidden />}
                disabled={!manual.ok || (busy !== null && busy !== 'manual')}
                busy={busy === 'manual'}
                onClick={() => createClip('manual', { startMs: manualStart, endMs: manualEnd })}
              >
                Create clip
              </Button>
            </div>
            {errorFor('manual') ? (
              <Banner tone="danger" live>
                {errorFor('manual')}
              </Banner>
            ) : null}
          </Card>
        ) : null}

        {clips.length > 0 ? (
          <section className="r-stack" aria-labelledby={`${ids}-clips`}>
            <h2 id={`${ids}-clips`}>Clips from this video</h2>
            <ul className="clip-links">
              {clips.map((clip) => (
                <li key={clip.id}>
                  <Link href={`/w/${slug}/clips/${clip.id}`} className="r-strong">
                    {clip.title}
                  </Link>
                  <span className="r-xs r-muted r-tabular">
                    {formatTimecode(clip.startMs)} – {formatTimecode(clip.endMs)} ·{' '}
                    {clip.aspect === 'original' ? 'original shape' : clip.aspect} · revision{' '}
                    {clip.revisionNumber}
                    {clip.hasCaptions ? ' · captions' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
