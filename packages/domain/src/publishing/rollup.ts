import { DESTINATION_STATES, STATE_LABELS, type DestinationState } from './states';

/** Roll up per-destination states into one post-level summary. Mixed is a first-class result. */
export type PostRollup =
  | { kind: 'empty'; label: string }
  | { kind: 'uniform'; state: DestinationState; label: string; total: number }
  | {
      kind: 'mixed';
      label: string;
      total: number;
      counts: Partial<Record<DestinationState, number>>;
      /** The state needing attention first, if any. */
      attention: DestinationState | null;
    };

const ATTENTION_ORDER: DestinationState[] = [
  'needs_reconciliation',
  'failed',
  'failed_permanent',
  'blocked',
  'changes_requested',
  'needs_review',
];

export function rollupStates(states: DestinationState[]): PostRollup {
  if (states.length === 0) return { kind: 'empty', label: 'No destinations' };
  const counts: Partial<Record<DestinationState, number>> = {};
  for (const s of states) counts[s] = (counts[s] ?? 0) + 1;
  const distinct = Object.keys(counts) as DestinationState[];
  if (distinct.length === 1) {
    const state = distinct[0]!;
    return { kind: 'uniform', state, label: STATE_LABELS[state], total: states.length };
  }
  // Most common first; ties follow lifecycle order so the label never depends on row order.
  const parts = distinct
    .sort(
      (a, b) =>
        (counts[b] ?? 0) - (counts[a] ?? 0) ||
        DESTINATION_STATES.indexOf(a) - DESTINATION_STATES.indexOf(b),
    )
    .map((s) => `${counts[s]} ${STATE_LABELS[s].toLowerCase()}`);
  const attention = ATTENTION_ORDER.find((s) => counts[s]) ?? null;
  return {
    kind: 'mixed',
    label: `Mixed: ${parts.join(', ')}`,
    total: states.length,
    counts,
    attention,
  };
}
