import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, LoaderCircle } from 'lucide-react';
import { Badge } from '@relay/ui';

export type AnalysisState =
  | { kind: 'none' }
  | { kind: 'running'; queued: boolean }
  | { kind: 'failed' }
  | { kind: 'no_signal' }
  | { kind: 'done'; count: number };

export function analysisState(
  analysis: {
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    noSignal: boolean;
    candidateCount: number;
  } | null,
): AnalysisState {
  if (!analysis) return { kind: 'none' };
  if (analysis.status === 'failed') return { kind: 'failed' };
  if (analysis.status !== 'succeeded')
    return { kind: 'running', queued: analysis.status === 'queued' };
  if (analysis.noSignal || analysis.candidateCount === 0) return { kind: 'no_signal' };
  return { kind: 'done', count: analysis.candidateCount };
}

/** Analysis state with its own icon and wording, so it never depends on colour. */
export function AnalysisBadge({ state }: { state: AnalysisState }) {
  switch (state.kind) {
    case 'none':
      return <Badge icon={<CircleDashed aria-hidden />}>Not analysed</Badge>;
    case 'running':
      return (
        <Badge tone="info" icon={<LoaderCircle aria-hidden />}>
          {state.queued ? 'Waiting to analyse' : 'Analysing'}
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="danger" icon={<CircleAlert aria-hidden />}>
          Analysis failed
        </Badge>
      );
    case 'no_signal':
      return <Badge icon={<CircleSlash aria-hidden />}>No clear highlights</Badge>;
    case 'done':
      return (
        <Badge tone="success" icon={<CircleCheck aria-hidden />}>
          {state.count} suggestion{state.count === 1 ? '' : 's'}
        </Badge>
      );
  }
}
