import { describe, expect, it } from 'vitest';
import { DEFAULT_DECLARATIONS, ManualClock } from '@relay/domain';
import { SIMULATED_ACCOUNT_TYPES } from './catalog';
import {
  SIMULATOR_PERMALINK_HOST,
  createSimulatorMetricsAdapter,
  createSimulatorPublishingAdapter,
  simulatedExternalId,
  type SimulatorRemotePost,
  type SimulatorStore,
} from './simulator';
import { ProviderTimeoutError, type ConnectedAccount, type PublishCheckpoint, type PublishIntent, type SimulatorProfile, type StepResult } from './types';

/** In-memory stand-in for the provider_sim schema (the real store is covered by integration tests). */
function memoryStore(clock: ManualClock): SimulatorStore & { posts: Map<string, SimulatorRemotePost> } {
  const posts = new Map<string, SimulatorRemotePost>();
  const counters = new Map<string, number>();
  return {
    posts,
    async findByOperation(op) {
      return posts.get(op) ?? null;
    },
    async upsertStaged(post) {
      if (!posts.has(post.operationId)) posts.set(post.operationId, { ...post, createdAt: clock.now(), publishedAt: null });
      return posts.get(post.operationId)!;
    },
    async update(op, patch) {
      const p = posts.get(op);
      if (p) posts.set(op, { ...p, ...patch });
    },
    async bumpCounter(op, phase) {
      const key = `${op}:${phase}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return counters.get(key)!;
    },
    async listRecent() {
      return [...posts.values()];
    },
  };
}

const account = (profile: SimulatorProfile): ConnectedAccount => ({
  workspaceId: 'w1',
  socialAccountId: 'a1',
  provider: 'youtube',
  connectionMode: 'simulated',
  providerAccountId: 'sim-channel-1',
  accountType: SIMULATED_ACCOUNT_TYPES.youtube,
  grantedScopes: [],
  status: 'active',
  simulatorProfile: profile,
});

const intent: PublishIntent = {
  intentId: 'i1',
  intentVersion: 1,
  operationKey: 'w1:pd1:r1:1',
  plannedAt: '2026-11-09T10:00:00Z',
  payload: {
    workspaceId: 'w1',
    postId: 'p1',
    destination: { pageDestinationId: 'd1', socialAccountId: 'a1', provider: 'youtube', connectionMode: 'simulated', providerAccountId: 'sim-channel-1' },
    media: [{ position: 0, assetId: 'm1', assetVersion: 1, kind: 'video', sha256: 'ab'.repeat(32) }],
    caption: 'Hello',
    title: 'Title',
    visibility: 'public',
    metadata: {},
    declarations: DEFAULT_DECLARATIONS,
    rights: [],
  },
  media: [{ position: 0, assetId: 'm1', assetVersion: 1, kind: 'video', mime: 'video/mp4', sizeBytes: 1_000_000, width: 1080, height: 1920, durationMs: 8000, sha256: 'ab'.repeat(32) }],
};

/** Drive the adapter like the worker would, recording each outcome kind. */
async function drive(profile: SimulatorProfile, maxSteps = 20) {
  const clock = new ManualClock('2026-11-09T10:00:00Z');
  const store = memoryStore(clock);
  const adapter = createSimulatorPublishingAdapter('youtube', { store, clock });
  let checkpoint: PublishCheckpoint = { phase: adapter.initialPhase() };
  const steps: string[] = [];
  let last: StepResult | null = null;
  for (let i = 0; i < maxSteps; i++) {
    let result: StepResult;
    try {
      result = await adapter.advance({ account: account(profile), intent, checkpoint, operationId: `op${i}`, signal: new AbortController().signal });
    } catch (error) {
      steps.push(error instanceof ProviderTimeoutError ? `${checkpoint.phase}:timeout` : `${checkpoint.phase}:error`);
      break;
    }
    steps.push(`${checkpoint.phase}:${result.kind}`);
    last = result;
    if (result.kind === 'continue' || result.kind === 'waiting') checkpoint = result.checkpoint;
    else if (result.kind === 'retryable' || result.kind === 'rate_limited') continue;
    else break;
    clock.advance(5000);
  }
  return { steps, last, store, adapter, clock };
}

describe('simulator publishing adapter', () => {
  it('reliable: prepares privately, dispatches once and confirms with the intended visibility', async () => {
    const { steps, last, store } = await drive('reliable');
    expect(steps).toEqual(['prepare:continue', 'transfer:continue', 'wait_processing:continue', 'dispatch:continue', 'confirm:confirmed']);
    expect(last).toMatchObject({ kind: 'confirmed', visibility: 'public', providerPostId: simulatedExternalId('youtube', intent.operationKey) });
    expect(last?.kind === 'confirmed' && new URL(last.permalink!).host).toBe(SIMULATOR_PERMALINK_HOST); // never a real platform URL
    expect(store.posts.size).toBe(1);
  });

  it('slow_processing waits with a next-check time before dispatching', async () => {
    const { steps } = await drive('slow_processing');
    expect(steps.filter((s) => s === 'wait_processing:waiting')).toHaveLength(2);
    expect(steps.at(-1)).toBe('confirm:confirmed');
  });

  it('rate_limited_once and transient_then_ok recover without a second remote post', async () => {
    for (const profile of ['rate_limited_once', 'transient_then_ok'] as const) {
      const { steps, store } = await drive(profile);
      expect(steps.some((s) => s.endsWith(':rate_limited') || s.endsWith(':retryable'))).toBe(true);
      expect(steps.at(-1)).toBe('confirm:confirmed');
      expect(store.posts.size).toBe(1);
    }
  });

  it('reject_format is a permanent refusal', async () => {
    const { steps, last } = await drive('reject_format');
    expect(steps.at(-1)).toBe('dispatch:rejected');
    expect(last).toMatchObject({ kind: 'rejected', code: 'sim_format_rejected' });
  });

  it('lost_response: the post goes live but the reply is lost; reconciliation proves it, exactly once', async () => {
    const { steps, store, adapter } = await drive('lost_response');
    expect(steps.at(-1)).toBe('dispatch:timeout');
    expect([...store.posts.values()][0]!.status).toBe('published');
    const r = await adapter.reconcile({ account: account('lost_response'), intent, checkpoint: { phase: 'dispatch' }, operationId: 'rec' });
    expect(r).toMatchObject({ kind: 'published', visibility: 'public' });
    expect(store.posts.size).toBe(1);
  });

  it('ambiguous: reconciliation cannot prove the outcome, so an operator must decide', async () => {
    const { adapter } = await drive('ambiguous');
    const r = await adapter.reconcile({ account: account('ambiguous'), intent, checkpoint: { phase: 'dispatch' }, operationId: 'rec' });
    expect(r.kind).toBe('indeterminate');
  });

  it('proves "not sent" only by an idempotent lookup that finds nothing', async () => {
    const clock = new ManualClock('2026-11-09T10:00:00Z');
    const adapter = createSimulatorPublishingAdapter('youtube', { store: memoryStore(clock), clock });
    const r = await adapter.reconcile({ account: account('reliable'), intent, checkpoint: { phase: 'prepare' }, operationId: 'rec' });
    expect(r).toEqual({ kind: 'not_found', proof: 'idempotent_lookup' });
  });

  it('marks which phases have side effects and which may run before the planned time', () => {
    const clock = new ManualClock('2026-11-09T10:00:00Z');
    const adapter = createSimulatorPublishingAdapter('youtube', { store: memoryStore(clock), clock });
    expect(adapter.isSideEffecting('dispatch')).toBe(true);
    expect(adapter.isSideEffecting('confirm')).toBe(false);
    expect(adapter.mayRunBeforePlannedTime('prepare')).toBe(true);
    expect(adapter.mayRunBeforePlannedTime('dispatch')).toBe(false);
    expect(adapter.mode).toBe('simulated');
  });
});

describe('simulator metrics adapter', () => {
  const metrics = createSimulatorMetricsAdapter('youtube');
  const publication = { externalId: 'sim_youtube_abc', publishedAt: '2026-11-09T10:00:00Z', format: 'video' as const };
  const read = (now: string) => metrics.fetchPostMetrics({ account: account('reliable'), publication, ageBucket: null, now: new Date(now) });

  it('is deterministic for the same publication and age, and grows with age', async () => {
    expect(await read('2026-11-10T10:00:00Z')).toEqual(await read('2026-11-10T10:00:00Z'));
    const day1 = (await read('2026-11-10T10:00:00Z')).find((m) => m.metricKey === 'views')!.value!;
    const day7 = (await read('2026-11-16T10:00:00Z')).find((m) => m.metricKey === 'views')!.value!;
    expect(day7).toBeGreaterThan(day1);
  });

  it('labels unavailable metrics instead of reporting zero', async () => {
    const early = await read('2026-11-09T11:00:00Z');
    expect(early.find((m) => m.metricKey === 'watch_time_seconds')).toMatchObject({ value: null, availability: 'not_yet_reported' });
    expect(early.find((m) => m.metricKey === 'saves')).toMatchObject({ value: null, availability: 'not_supported' });
    expect(metrics.sourcePolicy).toBe('simulator:synthetic');
  });
});
