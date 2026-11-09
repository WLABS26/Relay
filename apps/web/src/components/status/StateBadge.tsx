import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  OctagonX,
  PenLine,
  RefreshCw,
  Send,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { STATE_LABELS, type DestinationState } from '@relay/domain';
import { Badge, type Tone } from '@relay/ui';

/**
 * Every lifecycle state has its own icon AND label (never colour alone), so scheduled,
 * in-flight, published, blocked, failed and unknown outcomes are distinguishable for
 * everyone, including in grayscale and for screen readers.
 */
const STATE_STYLE: Record<DestinationState, { tone: Tone; icon: ReactNode }> = {
  draft: { tone: 'neutral', icon: <PenLine aria-hidden /> },
  needs_review: { tone: 'info', icon: <Hourglass aria-hidden /> },
  changes_requested: { tone: 'warning', icon: <Undo2 aria-hidden /> },
  approved: { tone: 'success', icon: <CircleDashed aria-hidden /> },
  scheduled: { tone: 'info', icon: <CalendarClock aria-hidden /> },
  preparing: { tone: 'info', icon: <Clock aria-hidden /> },
  dispatching: { tone: 'info', icon: <Send aria-hidden /> },
  processing: { tone: 'info', icon: <LoaderCircle aria-hidden /> },
  published: { tone: 'success', icon: <CircleCheck aria-hidden /> },
  blocked: { tone: 'warning', icon: <ShieldAlert aria-hidden /> },
  needs_reconciliation: { tone: 'danger', icon: <CircleHelp aria-hidden /> },
  failed: { tone: 'danger', icon: <RefreshCw aria-hidden /> },
  failed_permanent: { tone: 'danger', icon: <OctagonX aria-hidden /> },
  expired: { tone: 'neutral', icon: <CircleX aria-hidden /> },
  canceled: { tone: 'neutral', icon: <Ban aria-hidden /> },
};

export function StateBadge({ state, label }: { state: DestinationState; label?: string }) {
  const style = STATE_STYLE[state];
  return (
    <Badge tone={style.tone} icon={style.icon}>
      {label ?? STATE_LABELS[state]}
    </Badge>
  );
}

export function RollupBadge({ rollup }: { rollup: { kind: string; label: string; state?: DestinationState; attention?: DestinationState | null } }) {
  if (rollup.kind === 'uniform' && rollup.state) return <StateBadge state={rollup.state} />;
  if (rollup.kind === 'mixed') {
    const tone = rollup.attention ? STATE_STYLE[rollup.attention].tone : 'neutral';
    return (
      <Badge tone={tone} icon={rollup.attention ? STATE_STYLE[rollup.attention].icon : undefined} title={rollup.label}>
        {rollup.label}
      </Badge>
    );
  }
  return <Badge>{rollup.label}</Badge>;
}
