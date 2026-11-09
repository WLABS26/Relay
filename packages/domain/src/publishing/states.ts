import { AppError } from '../errors';

/**
 * Post-destination lifecycle. One row per (post, page destination); this table is the only
 * place transitions are defined, and both HTTP commands and worker tasks go through
 * `nextState()`. Adapters that prepare or process around dispatch express that through
 * checkpoints rather than pretending every provider has the same sequence.
 */

export const DESTINATION_STATES = [
  'draft',
  'needs_review',
  'changes_requested',
  'approved',
  'scheduled',
  'preparing',
  'dispatching',
  'processing',
  'published',
  'blocked',
  'needs_reconciliation',
  'failed',
  'failed_permanent',
  'expired',
  'canceled',
] as const;
export type DestinationState = (typeof DESTINATION_STATES)[number];

export const TRANSITION_TRIGGERS = [
  'submit',
  'approve',
  'reject',
  'edit',
  'schedule',
  'reschedule',
  'unschedule',
  'claim_prepare',
  'claim_dispatch',
  'accepted',
  'confirmed',
  'block',
  'unblock',
  'unknown_outcome',
  'rejected_by_provider',
  'retries_exhausted',
  'retry',
  'reconciled_not_sent',
  'reconciled_processing',
  'link_external',
  'close_not_published',
  'expire',
  'withdraw',
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

type Table = Record<DestinationState, Partial<Record<TransitionTrigger, DestinationState>>>;

const PRE_DISPATCH_EDITABLE = { edit: 'draft', withdraw: 'canceled' } as const;

export const TRANSITIONS: Table = {
  draft: { submit: 'needs_review', edit: 'draft', withdraw: 'canceled' },
  needs_review: {
    approve: 'approved',
    reject: 'changes_requested',
    // A new revision while in review keeps it in review; the reviewer approves what they saw.
    edit: 'needs_review',
    withdraw: 'canceled',
  },
  changes_requested: { submit: 'needs_review', ...PRE_DISPATCH_EDITABLE },
  // `submit` from approved re-requests review when the approval went stale (rights/media changed).
  approved: { schedule: 'scheduled', submit: 'needs_review', ...PRE_DISPATCH_EDITABLE, expire: 'expired' },
  scheduled: {
    reschedule: 'scheduled',
    unschedule: 'approved',
    claim_prepare: 'preparing',
    claim_dispatch: 'dispatching',
    block: 'blocked',
    expire: 'expired',
    ...PRE_DISPATCH_EDITABLE,
  },
  preparing: {
    claim_prepare: 'preparing',
    claim_dispatch: 'dispatching',
    reschedule: 'scheduled',
    unschedule: 'approved',
    block: 'blocked',
    unknown_outcome: 'needs_reconciliation',
    rejected_by_provider: 'failed_permanent',
    retries_exhausted: 'failed',
    expire: 'expired',
  },
  // After the dispatch claim commits the post is in flight: no edit, cancel or block.
  dispatching: {
    accepted: 'processing',
    confirmed: 'published',
    unknown_outcome: 'needs_reconciliation',
    rejected_by_provider: 'failed_permanent',
    retries_exhausted: 'failed',
  },
  processing: {
    accepted: 'processing',
    confirmed: 'published',
    unknown_outcome: 'needs_reconciliation',
    rejected_by_provider: 'failed_permanent',
    retries_exhausted: 'failed',
  },
  published: {},
  blocked: {
    unblock: 'scheduled',
    reschedule: 'scheduled',
    unschedule: 'approved',
    expire: 'expired',
    ...PRE_DISPATCH_EDITABLE,
  },
  needs_reconciliation: {
    link_external: 'published',
    close_not_published: 'failed',
    reconciled_not_sent: 'scheduled',
    reconciled_processing: 'processing',
    confirmed: 'published',
  },
  failed: { retry: 'scheduled', unschedule: 'approved', ...PRE_DISPATCH_EDITABLE },
  // Terminal for the intent; a new revision reopens the destination as a fresh draft.
  failed_permanent: { edit: 'draft', withdraw: 'canceled' },
  expired: { edit: 'draft', withdraw: 'canceled' },
  canceled: {},
};

export const TERMINAL_STATES: ReadonlySet<DestinationState> = new Set([
  'published',
  'failed_permanent',
  'expired',
  'canceled',
]);

/** States in which the worker owns progress. */
export const IN_FLIGHT_STATES: ReadonlySet<DestinationState> = new Set([
  'preparing',
  'dispatching',
  'processing',
]);

/** States that hold an active slot reservation. */
export const RESERVING_STATES: ReadonlySet<DestinationState> = new Set([
  'scheduled',
  'preparing',
  'dispatching',
  'processing',
  'blocked',
  'needs_reconciliation',
  'failed',
]);

export function canTransition(from: DestinationState, trigger: TransitionTrigger): boolean {
  return TRANSITIONS[from][trigger] !== undefined;
}

/** Resolve a transition or throw `invalid_transition` with a user-readable message. */
export function nextState(from: DestinationState, trigger: TransitionTrigger): DestinationState {
  const to = TRANSITIONS[from][trigger];
  if (!to) {
    throw new AppError(
      'invalid_transition',
      `Cannot ${TRIGGER_VERBS[trigger]} a destination that is ${STATE_LABELS[from].toLowerCase()}.`,
      { details: { from, trigger } },
    );
  }
  return to;
}

const TRIGGER_VERBS: Record<TransitionTrigger, string> = {
  submit: 'submit',
  approve: 'approve',
  reject: 'request changes on',
  edit: 'edit',
  schedule: 'schedule',
  reschedule: 'reschedule',
  unschedule: 'unschedule',
  claim_prepare: 'prepare',
  claim_dispatch: 'publish',
  accepted: 'accept',
  confirmed: 'confirm',
  block: 'block',
  unblock: 'resume',
  unknown_outcome: 'flag',
  rejected_by_provider: 'reject',
  retries_exhausted: 'fail',
  retry: 'retry',
  reconciled_not_sent: 'reconcile',
  reconciled_processing: 'reconcile',
  link_external: 'link',
  close_not_published: 'close',
  expire: 'expire',
  withdraw: 'withdraw',
};

export const STATE_LABELS: Record<DestinationState, string> = {
  draft: 'Draft',
  needs_review: 'Needs review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  scheduled: 'Scheduled',
  preparing: 'Preparing',
  dispatching: 'Publishing',
  processing: 'Processing at platform',
  published: 'Published',
  blocked: 'Blocked',
  needs_reconciliation: 'Outcome unknown',
  failed: 'Failed',
  failed_permanent: 'Rejected by platform',
  expired: 'Expired',
  canceled: 'Canceled',
};

export const STATE_DESCRIPTIONS: Record<DestinationState, string> = {
  draft: 'Not yet submitted for review.',
  needs_review: 'Waiting for a publisher to approve this exact version.',
  changes_requested: 'A reviewer asked for changes before approval.',
  approved: 'Approved and ready to schedule.',
  scheduled: 'A slot is reserved. Relay will publish at the planned time.',
  preparing: 'Relay is preparing media for the platform ahead of the planned time.',
  dispatching: 'Relay has claimed this post and is sending it to the platform.',
  processing: 'The platform accepted the post and is still processing it.',
  published: 'The platform confirmed the post with the intended visibility.',
  blocked: 'Publishing is held: see the reason and resolve it to continue.',
  needs_reconciliation:
    'Relay cannot prove whether the platform received the post. It will not resend until someone verifies the outcome.',
  failed: 'Publishing failed after retries. You can retry from the last verified step.',
  failed_permanent: 'The platform refused this post. Edit it to try again.',
  expired: 'The approval window ended before publishing.',
  canceled: 'Withdrawn from this destination.',
};

export const BLOCK_REASONS = {
  page_paused: 'The page is paused.',
  workspace_paused: 'The workspace is paused.',
  connection_unhealthy: 'The connected account needs attention (reconnect it).',
  connection_revoked: 'The connected account was disconnected.',
  rights_changed: 'Media rights changed after approval.',
  approval_invalid: 'The approval no longer matches this content.',
  media_unavailable: 'Media is no longer available.',
  missed_schedule: 'The planned time passed before Relay could publish (beyond the grace period).',
  simulator_disabled: 'Simulated connections are disabled in this deployment.',
  kill_switch: 'Publishing is globally halted by an operator.',
  capability_unavailable: 'This destination can no longer publish this format.',
} as const;
export type BlockReason = keyof typeof BLOCK_REASONS;
