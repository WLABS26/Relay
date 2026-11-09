import { createHash } from 'node:crypto';
import {
  hashToSeed,
  seededRandom,
  validateForDestination,
  type AgeBucket,
  type Clock,
  type DestinationProviderId,
  type Visibility,
} from '@relay/domain';
import { SIMULATED_ACCOUNT_TYPES, SIMULATOR_FORMAT_PROFILES } from './catalog';
import {
  ProviderTimeoutError,
  type ConnectedAccount,
  type MetricReading,
  type MetricsAdapter,
  type PublishCheckpoint,
  type PublishingAdapter,
  type PublishingCapabilities,
  type PublishIntent,
  type PublishPhase,
  type ReconcileResult,
  type SimulatorProfile,
  type StepResult,
  type ValidationIssue,
} from './types';

/**
 * Deterministic provider simulator.
 *
 * It behaves like a remote platform: state lives in its own store (the provider_sim schema),
 * posts are keyed by the intent's operation key, and calls happen outside Relay's business
 * transactions. Each simulated account has a profile that scripts its behaviour, so demos and
 * tests can exercise slow processing, rate limits, transient errors, lost responses,
 * indistinguishable outcomes and permanent rejections deterministically.
 *
 * A simulator success demonstrates workflow behaviour only. It is never a live publication.
 */

export interface SimulatorRemotePost {
  id: string;
  provider: DestinationProviderId;
  accountRef: string;
  operationId: string;
  externalId: string;
  containerId: string;
  status: 'staged' | 'processing' | 'published' | 'rejected';
  visibility: Visibility;
  format: string;
  captionSha256: string;
  mediaCount: number;
  processingPollsRemaining: number;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface SimulatorStore {
  findByOperation(operationId: string): Promise<SimulatorRemotePost | null>;
  /** Insert if absent (idempotent on operationId) and return the stored row. */
  upsertStaged(post: Omit<SimulatorRemotePost, 'createdAt' | 'publishedAt'>): Promise<SimulatorRemotePost>;
  update(
    operationId: string,
    patch: Partial<Pick<SimulatorRemotePost, 'status' | 'visibility' | 'processingPollsRemaining' | 'publishedAt'>>,
  ): Promise<void>;
  /** Atomically increment and return the call count for (operation, phase). */
  bumpCounter(operationId: string, phase: string): Promise<number>;
  listRecent(provider: DestinationProviderId, accountRef: string, limit: number): Promise<SimulatorRemotePost[]>;
}

export const SIMULATOR_PERMALINK_HOST = 'simulator.relay.invalid';

function shortHash(input: string, length = 12): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function simulatedExternalId(provider: string, operationKey: string): string {
  return `sim_${provider}_${shortHash(`post:${operationKey}`)}`;
}

function simulatedContainerId(provider: string, operationKey: string): string {
  return `simc_${provider}_${shortHash(`container:${operationKey}`)}`;
}

export function simulatedPermalink(provider: string, externalId: string): string {
  return `https://${SIMULATOR_PERMALINK_HOST}/${provider}/${externalId}`;
}

function profileOf(account: ConnectedAccount): SimulatorProfile {
  return account.simulatorProfile ?? 'reliable';
}

export function createSimulatorPublishingAdapter(
  provider: DestinationProviderId,
  deps: { store: SimulatorStore; clock: Clock; pollIntervalMs?: number; rateLimitSeconds?: number },
): PublishingAdapter {
  const pollMs = deps.pollIntervalMs ?? 2000;
  const rateLimitSeconds = deps.rateLimitSeconds ?? 2;
  const profile = SIMULATOR_FORMAT_PROFILES[provider];

  const sideEffecting: Record<PublishPhase, boolean> = {
    prepare: true, // creates a private container at the platform
    transfer: true, // uploads bytes into that container
    wait_processing: false,
    dispatch: true, // the public side effect
    confirm: false,
  };

  async function capabilities(account: ConnectedAccount): Promise<PublishingCapabilities> {
    return {
      provider,
      mode: 'simulated',
      profile,
      requiredScopes: {},
      // The simulator implements every capability; per-destination format support comes from
      // the format profile and is evaluated separately (formatSupported).
      implemented: { 'publish.video': true, 'publish.image': true, 'publish.carousel': true, 'metrics.read': true, 'export.manual': true },
      programApproval: 'not_required',
      accountTypeSupported: account.accountType === SIMULATED_ACCOUNT_TYPES[provider],
    };
  }

  function validate(intent: PublishIntent, caps: PublishingCapabilities): ValidationIssue[] {
    return validateForDestination(caps.profile, {
      media: intent.media.map((m) => ({
        kind: m.kind,
        mime: m.mime,
        sizeBytes: m.sizeBytes,
        width: m.width,
        height: m.height,
        durationMs: m.durationMs,
      })),
      caption: intent.payload.caption,
      title: intent.payload.title,
      visibility: intent.payload.visibility,
    });
  }

  async function advance(input: {
    account: ConnectedAccount;
    intent: Readonly<PublishIntent>;
    checkpoint: PublishCheckpoint;
    operationId: string;
    signal: AbortSignal;
  }): Promise<StepResult> {
    const { account, intent, checkpoint } = input;
    const op = intent.operationKey;
    const behaviour = profileOf(account);
    const now = deps.clock.now();

    switch (checkpoint.phase) {
      case 'prepare': {
        const post = await deps.store.upsertStaged({
          id: crypto.randomUUID(),
          provider,
          accountRef: account.providerAccountId,
          operationId: op,
          externalId: simulatedExternalId(provider, op),
          containerId: simulatedContainerId(provider, op),
          status: 'staged',
          visibility: 'private',
          format: intent.media.length > 1 ? 'carousel' : (intent.media[0]?.kind ?? 'video'),
          captionSha256: createHash('sha256').update(intent.payload.caption).digest('hex'),
          mediaCount: intent.media.length,
          processingPollsRemaining: behaviour === 'slow_processing' ? 2 : 0,
        });
        return { kind: 'continue', checkpoint: { phase: 'transfer', receiptId: post.containerId } };
      }
      case 'transfer': {
        if (behaviour === 'transient_then_ok' && (await deps.store.bumpCounter(op, 'transfer')) === 1) {
          return { kind: 'retryable', code: 'sim_platform_unavailable', message: 'Simulated temporary platform error (503).' };
        }
        const post = await deps.store.findByOperation(op);
        if (!post) return { kind: 'retryable', code: 'sim_container_missing', message: 'Container not found; preparing again.' };
        if (post.status === 'staged') await deps.store.update(op, { status: 'processing' });
        return { kind: 'continue', checkpoint: { ...checkpoint, phase: 'wait_processing' } };
      }
      case 'wait_processing': {
        const post = await deps.store.findByOperation(op);
        if (!post) return { kind: 'unknown', code: 'sim_container_missing', message: 'The simulated container disappeared.' };
        if (post.processingPollsRemaining > 0) {
          await deps.store.update(op, { processingPollsRemaining: post.processingPollsRemaining - 1 });
          const nextCheckAt = new Date(now.getTime() + pollMs).toISOString();
          return { kind: 'waiting', checkpoint: { ...checkpoint, phase: 'wait_processing', nextCheckAt }, nextCheckAt };
        }
        return { kind: 'continue', checkpoint: { ...checkpoint, phase: 'dispatch' } };
      }
      case 'dispatch': {
        if (behaviour === 'reject_format') {
          await deps.store.update(op, { status: 'rejected' });
          return { kind: 'rejected', code: 'sim_format_rejected', message: 'The simulated platform rejected this media format.' };
        }
        if (behaviour === 'rate_limited_once' && (await deps.store.bumpCounter(op, 'dispatch')) === 1) {
          return { kind: 'rate_limited', retryAfterSeconds: rateLimitSeconds, code: 'sim_rate_limited' };
        }
        const post = await deps.store.findByOperation(op);
        if (!post) return { kind: 'unknown', code: 'sim_container_missing', message: 'The simulated container disappeared.' };
        if (post.status !== 'published') {
          await deps.store.update(op, { status: 'published', visibility: intent.payload.visibility, publishedAt: now });
        }
        if ((behaviour === 'lost_response' || behaviour === 'ambiguous') && (await deps.store.bumpCounter(op, 'dispatch_response')) === 1) {
          // The platform accepted the post, but the response never reaches Relay.
          throw new ProviderTimeoutError('Simulated lost response after the platform accepted the post');
        }
        return { kind: 'continue', checkpoint: { ...checkpoint, phase: 'confirm', providerPostId: post.externalId } };
      }
      case 'confirm': {
        const post = await deps.store.findByOperation(op);
        if (post?.status === 'published' && post.publishedAt) {
          return {
            kind: 'confirmed',
            checkpoint: { ...checkpoint, phase: 'confirm', providerPostId: post.externalId },
            providerPostId: post.externalId,
            containerId: post.containerId,
            permalink: simulatedPermalink(provider, post.externalId),
            publishedAt: post.publishedAt.toISOString(),
            visibility: post.visibility,
          };
        }
        return { kind: 'unknown', code: 'sim_not_visible', message: 'The simulated platform does not show the post yet.' };
      }
    }
  }

  async function reconcile(input: {
    account: ConnectedAccount;
    intent: Readonly<PublishIntent>;
    checkpoint: PublishCheckpoint;
    operationId: string;
  }): Promise<ReconcileResult> {
    if (profileOf(input.account) === 'ambiguous') {
      return { kind: 'indeterminate', reason: 'This simulated platform cannot look up posts by operation, so Relay cannot prove the outcome.' };
    }
    const post = await deps.store.findByOperation(input.intent.operationKey);
    if (!post) return { kind: 'not_found', proof: 'idempotent_lookup' };
    if (post.status === 'published' && post.publishedAt) {
      return {
        kind: 'published',
        checkpoint: { phase: 'confirm', receiptId: post.containerId, providerPostId: post.externalId },
        providerPostId: post.externalId,
        containerId: post.containerId,
        permalink: simulatedPermalink(provider, post.externalId),
        publishedAt: post.publishedAt.toISOString(),
        visibility: post.visibility,
      };
    }
    if (post.status === 'rejected') return { kind: 'indeterminate', reason: 'The simulated platform marked the post as rejected.' };
    // Staged or processing but never dispatched: resume from the last verified phase.
    return {
      kind: 'processing',
      checkpoint: { phase: post.status === 'staged' ? 'transfer' : 'wait_processing', receiptId: post.containerId },
    };
  }

  return {
    provider,
    mode: 'simulated',
    capabilities,
    validate,
    initialPhase: () => 'prepare',
    isSideEffecting: (phase) => sideEffecting[phase],
    mayRunBeforePlannedTime: (phase) => phase !== 'dispatch' && phase !== 'confirm',
    advance,
    reconcile,
  };
}

/** Deterministic synthetic metrics: same publication and age always yield the same values. */
export function createSimulatorMetricsAdapter(provider: DestinationProviderId): MetricsAdapter {
  return {
    provider,
    mode: 'simulated',
    sourcePolicy: 'simulator:synthetic',
    async fetchPostMetrics({ publication, now }: {
      account: ConnectedAccount;
      publication: { externalId: string; publishedAt: string; format: 'video' | 'image' | 'carousel' };
      ageBucket: AgeBucket | null;
      now: Date;
    }): Promise<MetricReading[]> {
      const observedAt = now.toISOString();
      const ageHours = Math.max(0, (now.getTime() - Date.parse(publication.publishedAt)) / 3_600_000);
      const rnd = seededRandom(hashToSeed(publication.externalId));
      const base = 400 + Math.floor(rnd() * 9600);
      const growth = 1 - Math.exp(-ageHours / 30);
      const views = Math.round(base * growth * (publication.format === 'video' ? 1.4 : 1));
      const reading = (metricKey: string, value: number | null, availability: MetricReading['availability'] = 'available'): MetricReading => ({
        metricKey,
        definitionVersion: 'sim-1',
        value: availability === 'available' ? value : null,
        availability,
        observedAt,
      });
      const avgViewSeconds = 6 + rnd() * 20;
      const readings: MetricReading[] = [
        reading('views', views),
        publication.format !== 'video'
          ? reading('watch_time_seconds', null, 'not_supported')
          : ageHours < 2
            ? reading('watch_time_seconds', null, 'not_yet_reported')
            : reading('watch_time_seconds', Math.round(views * avgViewSeconds)),
        reading('followers_gained', Math.round(views * (0.002 + rnd() * 0.004))),
        reading('interactions', Math.round(views * (0.03 + rnd() * 0.05))),
        provider === 'instagram'
          ? reading('saves', Math.round(views * (0.005 + rnd() * 0.01)))
          : provider === 'tiktok'
            ? reading('saves', null, 'missing_scope')
            : reading('saves', null, 'not_supported'),
      ];
      return readings;
    },
  };
}
