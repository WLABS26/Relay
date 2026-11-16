'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, Film, Sparkles } from 'lucide-react';
import { Banner, Button, linkButtonClass, SampleBadge } from '@relay/ui';
import { apiFetch, errorMessage } from '@/lib/client/api';
import { formatDuration } from '@/lib/format';
import { AnalysisBadge, analysisState } from './AnalysisBadge';
import type { StartAnalysisResult, WireClipSource } from './types';

/**
 * The workspace's ready source videos with the state of their analysis. "Analyse" queues the
 * analysis and opens the video, where progress and the suggestions are shown.
 */
export function SourceList({
  slug,
  workspaceId,
  sources,
  pageNames,
  showPage,
  canAnalyse,
}: {
  slug: string;
  workspaceId: string;
  sources: WireClipSource[];
  pageNames: Record<string, string>;
  showPage: boolean;
  canAnalyse: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ assetId: string; message: string } | null>(null);

  async function analyse(source: WireClipSource) {
    setBusy(source.id);
    setFailure(null);
    try {
      await apiFetch<StartAnalysisResult>(
        `/api/v1/workspaces/${workspaceId}/assets/${source.id}/analyses`,
        { body: {} },
      );
      router.push(`/w/${slug}/find-clips/${source.id}`);
    } catch (error) {
      setFailure({ assetId: source.id, message: errorMessage(error) });
      setBusy(null);
    }
  }

  return (
    <ul className="clip-sources" aria-label="Source videos">
      {sources.map((source) => {
        const state = analysisState(source.analysis);
        const href = `/w/${slug}/find-clips/${source.id}`;
        const needsAnalysis = state.kind === 'none' || state.kind === 'failed';
        return (
          <li key={source.id} className="r-card clip-source">
            {source.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- private, short-lived signed URL: the image optimizer must not fetch or cache tenant media
              <img
                className="clip-source__thumb"
                src={source.thumbnailUrl}
                alt=""
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="clip-source__thumb" aria-hidden>
                <Film width={24} height={24} />
              </div>
            )}
            <div className="r-stack-sm clip-source__body">
              <h2 className="clip-source__title">
                <Link href={href}>{source.originalFilename}</Link>
              </h2>
              <p className="r-xs r-muted r-tabular">
                {formatDuration(source.durationMs)}
                {source.width && source.height ? ` · ${source.width}×${source.height}` : ''}
                {source.hasAudio === false ? ' · no audio' : ''}
                {showPage && pageNames[source.pageId] ? ` · ${pageNames[source.pageId]}` : ''}
              </p>
              <div className="r-row-tight">
                <AnalysisBadge state={state} />
                {source.clipCount > 0 ? (
                  <span className="r-xs r-muted">
                    {source.clipCount} clip{source.clipCount === 1 ? '' : 's'} made
                  </span>
                ) : null}
                {source.isSample ? <SampleBadge /> : null}
              </div>
              {failure?.assetId === source.id ? (
                <Banner tone="danger" live title="This video could not be analysed">
                  {failure.message} You can still open it and create a clip from a manual range.
                </Banner>
              ) : null}
            </div>
            <div className="clip-source__actions">
              {needsAnalysis && canAnalyse ? (
                <>
                  <Button
                    variant="primary"
                    icon={<Sparkles aria-hidden />}
                    busy={busy === source.id}
                    disabled={busy !== null && busy !== source.id}
                    aria-label={`${state.kind === 'failed' ? 'Analyse again' : 'Analyse'}: ${source.originalFilename}`}
                    onClick={() => analyse(source)}
                  >
                    {state.kind === 'failed' ? 'Analyse again' : 'Analyse'}
                  </Button>
                  <Link
                    className={linkButtonClass('ghost')}
                    href={href}
                    aria-label={`Open ${source.originalFilename}`}
                  >
                    Open
                  </Link>
                </>
              ) : (
                <Link
                  className={linkButtonClass('secondary')}
                  href={href}
                  aria-label={`${actionLabel(state.kind)}: ${source.originalFilename}`}
                >
                  {actionLabel(state.kind)} <ArrowRight aria-hidden />
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function actionLabel(kind: ReturnType<typeof analysisState>['kind']): string {
  switch (kind) {
    case 'done':
      return 'View suggestions';
    case 'running':
      return 'View progress';
    default:
      return 'Open';
  }
}
