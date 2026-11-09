import type {
  AgeBucket,
  CapabilityKey,
  ConnectionMode,
  DestinationFormatProfile,
  DestinationProviderId,
  MetricAvailability,
  PublishIntentPayload,
  Visibility,
} from '@relay/domain';

/**
 * Provider contracts. A platform may implement any subset of these independent interfaces
 * (authorise accounts, resolve/monitor sources, publish, read metrics). Nothing in these types
 * is sent to clients: signed upload URLs, tokens, cursors and raw provider errors stay inside
 * the adapter and the worker.
 */

export type PublishPhase = 'prepare' | 'transfer' | 'wait_processing' | 'dispatch' | 'confirm';

export const PUBLISH_PHASES: readonly PublishPhase[] = [
  'prepare',
  'transfer',
  'wait_processing',
  'dispatch',
  'confirm',
];

export interface PublishCheckpoint {
  phase: PublishPhase;
  /** Provider container/upload/video ID or an internal receipt pointer (never a secret). */
  receiptId?: string;
  /** Populated only once the provider has returned the post/video ID. */
  providerPostId?: string;
  nextCheckAt?: string;
}

export const SIMULATOR_PROFILES = [
  'reliable',
  'slow_processing',
  'rate_limited_once',
  'transient_then_ok',
  'lost_response',
  'ambiguous',
  'reject_format',
] as const;
export type SimulatorProfile = (typeof SIMULATOR_PROFILES)[number];

export interface ConnectedAccount {
  workspaceId: string;
  socialAccountId: string;
  provider: DestinationProviderId;
  connectionMode: ConnectionMode;
  providerAccountId: string;
  accountType: string;
  grantedScopes: readonly string[];
  status: 'active' | 'needs_reauth' | 'revoked' | 'disconnected';
  simulatorProfile: SimulatorProfile | null;
}

export interface IntentMediaItem {
  position: number;
  assetId: string;
  assetVersion: number;
  kind: 'video' | 'image';
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationMs: number | null;
  sha256: string;
}

/** The immutable, approved intent an adapter must publish exactly. */
export interface PublishIntent {
  intentId: string;
  intentVersion: number;
  operationKey: string;
  plannedAt: string;
  payload: Readonly<PublishIntentPayload>;
  media: readonly IntentMediaItem[];
}

export type StepResult =
  /** Phase done; continue with `checkpoint.phase` immediately. */
  | { kind: 'continue'; checkpoint: PublishCheckpoint }
  /** Provider is still working; check again at `nextCheckAt`. */
  | { kind: 'waiting'; checkpoint: PublishCheckpoint; nextCheckAt: string }
  /** Provider confirmed the post with this ID and visibility. */
  | {
      kind: 'confirmed';
      checkpoint: PublishCheckpoint;
      providerPostId: string;
      containerId?: string;
      permalink?: string;
      publishedAt: string;
      visibility: Visibility;
    }
  /** Permanent refusal (policy, unsupported content). Do not retry. */
  | { kind: 'rejected'; code: string; message: string }
  /** Provider asked us to slow down. Retry the same phase after the delay. */
  | { kind: 'rate_limited'; retryAfterSeconds: number; code: string }
  /** Transient failure known to be safe to retry (no side effect happened). */
  | { kind: 'retryable'; code: string; message: string }
  /** The request may or may not have taken effect. Reconcile before any resend. */
  | { kind: 'unknown'; code: string; message: string };

export type ReconcileResult =
  | {
      kind: 'published';
      checkpoint: PublishCheckpoint;
      providerPostId: string;
      containerId?: string;
      permalink?: string;
      publishedAt: string;
      visibility: Visibility;
    }
  | { kind: 'processing'; checkpoint: PublishCheckpoint }
  /** The provider can prove the operation did not take effect: safe to resume. */
  | { kind: 'not_found'; proof: 'idempotent_lookup' }
  /** Cannot distinguish "succeeded" from "never sent": an operator must decide. */
  | { kind: 'indeterminate'; reason: string };

export interface PublishingCapabilities {
  provider: DestinationProviderId;
  mode: ConnectionMode;
  /** Format rules for this account (provider or simulator profile). */
  profile: DestinationFormatProfile;
  /** Scopes each capability requires; compared against the grant. */
  requiredScopes: Partial<Record<CapabilityKey, readonly string[]>>;
  implemented: Partial<Record<CapabilityKey, boolean>>;
  programApproval: 'not_required' | 'approved' | 'pending' | 'denied';
  accountTypeSupported: boolean;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface PublishingAdapter {
  readonly provider: DestinationProviderId;
  readonly mode: ConnectionMode;
  capabilities(account: ConnectedAccount): Promise<PublishingCapabilities>;
  validate(intent: PublishIntent, caps: PublishingCapabilities): ValidationIssue[];
  /** First phase of a fresh publish. */
  initialPhase(): PublishPhase;
  /** Whether a phase can cause an external effect (a timeout there means "unknown"). */
  isSideEffecting(phase: PublishPhase): boolean;
  /** Whether a phase may run before the planned time (private, non-public staging only). */
  mayRunBeforePlannedTime(phase: PublishPhase): boolean;
  advance(input: {
    account: ConnectedAccount;
    intent: Readonly<PublishIntent>;
    checkpoint: PublishCheckpoint;
    operationId: string;
    signal: AbortSignal;
  }): Promise<StepResult>;
  reconcile(input: {
    account: ConnectedAccount;
    intent: Readonly<PublishIntent>;
    checkpoint: PublishCheckpoint;
    operationId: string;
  }): Promise<ReconcileResult>;
}

export interface MetricReading {
  metricKey: string;
  definitionVersion: string;
  value: number | null;
  availability: MetricAvailability;
  observedAt: string;
}

export interface MetricsAdapter {
  readonly provider: DestinationProviderId;
  readonly mode: ConnectionMode;
  /** Source-policy class recorded on every observation (retention / allowed use). */
  readonly sourcePolicy: string;
  fetchPostMetrics(input: {
    account: ConnectedAccount;
    publication: {
      externalId: string;
      publishedAt: string;
      format: 'video' | 'image' | 'carousel';
    };
    ageBucket: AgeBucket | null;
    now: Date;
  }): Promise<MetricReading[]>;
}

/** Thrown by adapters when a call timed out after the request may have been sent. */
export class ProviderTimeoutError extends Error {
  constructor(message = 'Provider request timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}
