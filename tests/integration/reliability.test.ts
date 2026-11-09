import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { ManualClock } from '@relay/domain';
import type { AdapterRegistry, PublishingAdapter } from '@relay/providers';
import {
  advancePublish,
  getInbox,
  getPostDetail,
  reconcilePublish,
  resolveReconciliation,
  retryDestination,
  scheduleDestination,
} from '@relay/services';
import {
  approvedPost,
  createTenant,
  destinationState,
  drivePublishing,
  expectAppError,
  makeContexts,
  meta,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

/** Wrap the registry so a test can stall one provider phase (simulating a hung or dead worker). */
function stallingRegistry(base: AdapterRegistry, stall: { phase: string; when: 'before' | 'after'; gate: Promise<void> } | null): AdapterRegistry {
  return {
    metrics: base.metrics.bind(base),
    publishing(provider, mode) {
      const adapter = base.publishing(provider, mode);
      if (!adapter || !stall) return adapter;
      const wrapped: PublishingAdapter = {
        ...adapter,
        async advance(input) {
          if (input.checkpoint.phase !== stall.phase) return adapter.advance(input);
          if (stall.when === 'before') {
            await stall.gate;
            return adapter.advance(input);
          }
          const result = await adapter.advance(input);
          await stall.gate;
          return result;
        },
      };
      return wrapped;
    },
  };
}

async function remotePosts(c: Contexts, operationPrefix: string) {
  return c.worker.db.selectFrom('providerSim.remotePosts').selectAll().where('operationId', 'like', `${operationPrefix}%`).execute();
}

describe('publish reliability: retries, unknown outcomes, takeover and mixed results (M1 gate)', () => {
  const clock = new ManualClock('2026-11-10T08:00:00Z');
  let c: Contexts;
  let t: Tenant;
  let video: string;

  beforeAll(async () => {
    c = makeContexts({ clock });
    t = await createTenant(c.app, {
      accounts: [
        { key: 'yt', provider: 'youtube', profile: 'reliable' },
        { key: 'igReject', provider: 'instagram', profile: 'reject_format' },
        { key: 'fbAmbiguous', provider: 'facebook_page', profile: 'ambiguous' },
        { key: 'ytLost', provider: 'youtube', profile: 'lost_response' },
        { key: 'ytRate', provider: 'youtube', profile: 'rate_limited_once' },
        { key: 'ytFlaky', provider: 'youtube', profile: 'transient_then_ok' },
        { key: 'ytSlow', provider: 'youtube', profile: 'slow_processing' },
      ],
    });
    video = (await uploadFixture(c, t, t.owner, 'vertical-1080x1920-8s.mp4', 'video/mp4')).assetId;
  });
  afterAll(async () => c.close());

  const asap = async (key: string, extraKeys: string[] = []) => {
    // Accounts are reused across tests: keep posts beyond the 2 h minimum gap (and out of quiet hours).
    clock.advance(3 * 3600_000);
    if (clock.now().getUTCHours() >= 21 || clock.now().getUTCHours() < 6) clock.set(new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth(), clock.now().getUTCDate() + (clock.now().getUTCHours() >= 21 ? 1 : 0), 7)));
    const p = await approvedPost(c, t, { destinationKeys: [key, ...extraKeys], assetIds: [video] });
    for (const k of [key, ...extraKeys]) {
      await scheduleDestination(c.app, t.owner, t.workspaceId, p.destinations[k]!.id, { expectedVersion: p.destinations[k]!.version, mode: 'asap' }, meta);
    }
    clock.advance(10_000);
    return p;
  };

  it('rolls up mixed outcomes: published, rejected and unknown on one post', async () => {
    const p = await asap('yt', ['igReject', 'fbAmbiguous']);
    const yt = await drivePublishing(c, t.workspaceId, p.destinations.yt!.id);
    const ig = await drivePublishing(c, t.workspaceId, p.destinations.igReject!.id);
    const fb = await drivePublishing(c, t.workspaceId, p.destinations.fbAmbiguous!.id);
    expect(yt.state).toBe('published');
    expect(ig.state).toBe('failed_permanent');
    expect(fb.state).toBe('needs_reconciliation');
    expect(fb.steps).toEqual(expect.arrayContaining(['dispatch:unknown', 'reconcile:indeterminate']));

    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, p.postId);
    expect(detail.rollup).toMatchObject({ kind: 'mixed', attention: 'needs_reconciliation', total: 3 });
    expect(detail.rollup.label).toMatch(/Mixed: /);
    const rejected = detail.destinations.find((d) => d.id === p.destinations.igReject!.id)!;
    expect(rejected.stateReason).toBe('sim_format_rejected');
    const inbox = await getInbox(c.app, t.owner, t.workspaceId);
    expect(inbox.items[0]).toMatchObject({ state: 'needs_reconciliation' });

    // The operator verifies on the platform and links the real external ID.
    const fbPd = await destinationState(c.app, t.workspaceId, p.destinations.fbAmbiguous!.id);
    const [remote] = await c.worker.db.selectFrom('providerSim.remotePosts').selectAll().where('accountRef', '=', (await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) => tx.selectFrom('socialAccounts').select('providerAccountId').where('id', '=', t.destinations.fbAmbiguous!.socialAccountId).executeTakeFirstOrThrow())).providerAccountId).execute();
    expect(remote?.status).toBe('published');
    const linked = await resolveReconciliation(c.app, t.owner, t.workspaceId, p.destinations.fbAmbiguous!.id, { action: 'link_external', expectedVersion: fbPd.version, externalId: remote!.externalId, reason: 'Verified on the simulated platform dashboard' }, meta);
    expect(linked.state).toBe('published');
    const after = await getPostDetail(c.app, t.owner, t.workspaceId, p.postId);
    expect(after.destinations.find((d) => d.id === p.destinations.fbAmbiguous!.id)).toMatchObject({ state: 'published', linkMethod: 'operator_linked' });
    expect(after.timeline.map((e) => e.action)).toContain('publication.linked');
  });

  it('reconciles a lost response through the provider lookup without resending', async () => {
    const p = await asap('ytLost');
    const run = await drivePublishing(c, t.workspaceId, p.destinations.ytLost!.id);
    expect(run.state, run.steps.join(' → ')).toBe('published');
    expect(run.steps).toEqual(expect.arrayContaining(['dispatch:unknown', 'reconcile:published']));
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, p.postId);
    expect(detail.destinations[0]).toMatchObject({ linkMethod: 'reconciled' });
    const remote = await remotePosts(c, `${t.workspaceId}:${p.destinations.ytLost!.id}`);
    expect(remote).toHaveLength(1); // exactly one platform post
  });

  it('retries rate limits and transient failures, honouring the recorded attempts', async () => {
    const rate = await asap('ytRate');
    const r1 = await drivePublishing(c, t.workspaceId, rate.destinations.ytRate!.id);
    expect(r1.state).toBe('published');
    expect(r1.steps).toContain('dispatch:rate_limited');
    const flaky = await asap('ytFlaky');
    const r2 = await drivePublishing(c, t.workspaceId, flaky.destinations.ytFlaky!.id);
    expect(r2.state).toBe('published');
    expect(r2.steps).toContain('transfer:retryable');
    const slow = await asap('ytSlow');
    const r3 = await drivePublishing(c, t.workspaceId, slow.destinations.ytSlow!.id);
    expect(r3.state).toBe('published');
    expect(r3.steps.filter((s) => s === 'wait_processing:waiting')).toHaveLength(2);
    const attempts = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.selectFrom('publishAttempts').select(['phase', 'status', 'retryAfter']).where('postDestinationId', '=', rate.destinations.ytRate!.id).orderBy('startedAt').execute(),
    );
    expect(attempts.find((a) => a.status === 'rate_limited')?.retryAfter).toBeInstanceOf(Date);
  });

  it('after a worker dies AFTER the provider write, takeover reconciles and never duplicates the post', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = c.worker.registry;
    c.worker.registry = stallingRegistry(original, { phase: 'dispatch', when: 'after', gate });
    try {
      const p = await asap('yt');
      const id = p.destinations.yt!.id;
      const intent = await withTenant(c.worker.db, { workspaceId: t.workspaceId }, (tx) =>
        tx.selectFrom('postDestinations as pd').innerJoin('publishIntents as i', 'i.id', 'pd.activeIntentId').select(['i.id', 'i.intentVersion', 'i.operationKey']).where('pd.id', '=', id).executeTakeFirstOrThrow(),
      );
      const payload = { workspaceId: t.workspaceId, postDestinationId: id, intentId: intent.id, intentVersion: intent.intentVersion };
      for (let i = 0; i < 3; i++) await advancePublish(c.worker, payload, { workerId: 'worker-A' });
      const hung = advancePublish(c.worker, payload, { workerId: 'worker-A' }); // claims dispatch, writes, then hangs
      await new Promise((r) => setTimeout(r, 300));
      expect((await destinationState(c.worker, t.workspaceId, id)).state).toBe('dispatching');
      clock.advance(5 * 60_000); // lease expires
      const takeover = await advancePublish(c.worker, payload, { workerId: 'worker-B' });
      expect(takeover.kind).toBe('reconcile');
      expect((await destinationState(c.worker, t.workspaceId, id)).state).toBe('needs_reconciliation');
      release();
      expect((await hung).kind).toBe('lost_lease'); // the stale worker cannot commit
      expect(await reconcilePublish(c.worker, { workspaceId: t.workspaceId, postDestinationId: id, intentId: intent.id }, { workerId: 'worker-B' })).toBe('published');
      expect(await remotePosts(c, intent.operationKey)).toHaveLength(1);
      const attempts = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) => tx.selectFrom('publishAttempts').select(['workerId', 'phase', 'status', 'errorCode']).where('postDestinationId', '=', id).orderBy('startedAt').execute());
      expect(attempts.find((a) => a.phase === 'dispatch')).toMatchObject({ workerId: 'worker-A', status: 'unknown', errorCode: 'worker_lost' });
    } finally {
      c.worker.registry = original;
      release();
    }
  });

  it('after a worker dies BEFORE the provider write, reconciliation proves nothing was sent and resumes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = c.worker.registry;
    c.worker.registry = stallingRegistry(original, { phase: 'dispatch', when: 'before', gate });
    try {
      const p = await asap('yt');
      const id = p.destinations.yt!.id;
      const intent = await withTenant(c.worker.db, { workspaceId: t.workspaceId }, (tx) =>
        tx.selectFrom('postDestinations as pd').innerJoin('publishIntents as i', 'i.id', 'pd.activeIntentId').select(['i.id', 'i.intentVersion', 'i.operationKey']).where('pd.id', '=', id).executeTakeFirstOrThrow(),
      );
      const payload = { workspaceId: t.workspaceId, postDestinationId: id, intentId: intent.id, intentVersion: intent.intentVersion };
      for (let i = 0; i < 3; i++) await advancePublish(c.worker, payload, { workerId: 'worker-A' });
      const hung = advancePublish(c.worker, payload, { workerId: 'worker-A' });
      await new Promise((r) => setTimeout(r, 300));
      clock.advance(5 * 60_000);
      expect((await advancePublish(c.worker, payload, { workerId: 'worker-B' })).kind).toBe('reconcile');
      c.worker.registry = original; // the dead worker never comes back
      expect(await reconcilePublish(c.worker, { workspaceId: t.workspaceId, postDestinationId: id, intentId: intent.id }, { workerId: 'worker-B' })).toBe('resumed');
      const run = await drivePublishing(c, t.workspaceId, id, { workerId: 'worker-B' });
      expect(run.state, run.steps.join(' → ')).toBe('published');
      expect(await remotePosts(c, intent.operationKey)).toHaveLength(1);
      release();
      expect((await hung).kind).toBe('lost_lease');
    } finally {
      c.worker.registry = original;
      release();
    }
  });

  it('lets an operator close an unknown outcome as not published, then retry from the checkpoint', async () => {
    const p = await asap('fbAmbiguous');
    const id = p.destinations.fbAmbiguous!.id;
    expect((await drivePublishing(c, t.workspaceId, id)).state).toBe('needs_reconciliation');
    const pd = await destinationState(c.app, t.workspaceId, id);
    // Owners/admins only; viewers and publishers cannot resolve.
    const closed = await resolveReconciliation(c.app, t.owner, t.workspaceId, id, { action: 'close_not_published', expectedVersion: pd.version, reason: 'Not visible on the platform after 24 h' }, meta);
    expect(closed.state).toBe('failed');
    const failed = await destinationState(c.app, t.workspaceId, id);
    const retried = await retryDestination(c.app, t.owner, t.workspaceId, id, { expectedVersion: failed.version }, meta);
    expect(retried.state).toBe('scheduled');
    await expectAppError(retryDestination(c.app, t.owner, t.workspaceId, id, { expectedVersion: failed.version }, meta), 'version_conflict');
  });
});
