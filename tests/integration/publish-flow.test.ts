import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { ManualClock } from '@relay/domain';
import {
  createPost,
  decideApprovals,
  getCalendar,
  getPostDetail,
  getResults,
  refreshMetrics,
  scheduleDestination,
  submitPost,
} from '@relay/services';
import { createTenant, drivePublishing, makeContexts, meta, uploadFixture, type Contexts, type Tenant } from './helpers';

describe('original content → approval → schedule → worker → confirmed simulated post', () => {
  let c: Contexts;
  let tenant: Tenant;
  const clock = new ManualClock('2026-11-12T08:00:00Z'); // Thursday 09:00 Europe/Berlin

  beforeAll(async () => {
    c = makeContexts({ clock });
    tenant = await createTenant(c.app, {
      accounts: [
        { key: 'youtube', provider: 'youtube' },
        { key: 'instagram', provider: 'instagram' },
      ],
    });
  });
  afterAll(async () => c.close());

  it('publishes a validated upload to two simulated destinations and records results', async () => {
    const upload = await uploadFixture(c, tenant, tenant.owner, 'vertical-1080x1920-8s.mp4', 'video/mp4');
    expect(upload.outcome).toBe('ready');

    const created = await createPost(
      c.app,
      tenant.owner,
      tenant.workspaceId,
      {
        pageId: tenant.pageId,
        title: 'Morning pour-over in 8 seconds',
        caption: 'Sample caption: brew guide #coffee',
        mediaAssetIds: [upload.assetId],
        destinationIds: [tenant.destinations.youtube!.pageDestinationId, tenant.destinations.instagram!.pageDestinationId],
      },
      meta,
    );
    const postId = created.body.postId;

    const submitted = await submitPost(c.app, tenant.owner, tenant.workspaceId, postId, {}, meta);
    expect(submitted.outcomes.every((o) => o.ok)).toBe(true);

    const detail = await getPostDetail(c.app, tenant.owner, tenant.workspaceId, postId);
    expect(detail.destinations).toHaveLength(2);
    const approvals = await decideApprovals(
      c.app,
      tenant.owner,
      tenant.workspaceId,
      postId,
      {
        decisions: detail.destinations.map((d) => ({
          postDestinationId: d.id,
          decision: 'approve' as const,
          revisionId: detail.revision.id,
          intentHash: d.intentHash,
        })),
      },
      meta,
    );
    expect(approvals.outcomes.map((o) => o.error?.message ?? o.state)).toEqual(['approved', 'approved']);

    const afterApproval = await getPostDetail(c.app, tenant.owner, tenant.workspaceId, postId);
    for (const d of afterApproval.destinations) {
      const scheduled = await scheduleDestination(c.app, tenant.owner, tenant.workspaceId, d.id, { expectedVersion: d.version, mode: 'at', localTime: '2026-11-12T10:30' }, meta).catch((e) => e);
      // Both destinations at the same local time is fine: they are different accounts.
      expect(scheduled.body?.state ?? scheduled.message).toBe('scheduled');
      expect(scheduled.body.civil).toBe('2026-11-12T10:30');
      expect(scheduled.body.offset).toBe('+01:00');
      expect(scheduled.body.plannedAt).toBe('2026-11-12T09:30:00.000Z');
    }

    const calendar = await getCalendar(c.app, tenant.owner, tenant.workspaceId, { from: '2026-11-09', to: '2026-11-15', pageId: tenant.pageId });
    expect(calendar.items.map((i) => [i.localTime, i.stateLabel])).toEqual([
      ['10:30', 'Scheduled'],
      ['10:30', 'Scheduled'],
    ]);

    const runs = [];
    for (const d of afterApproval.destinations) {
      const run = await drivePublishing(c, tenant.workspaceId, d.id);
      expect(run.state, run.steps.join(' → ')).toBe('published');
      runs.push(run);
    }
    // Private preparation may run early, but dispatch waited for the planned time (the first
    // run deferred and moved the manual clock; publishedAt is asserted below).
    expect(runs[0]!.steps.slice(0, 4)).toEqual(['prepare:continue', 'transfer:continue', 'wait_processing:continue', 'deferred']);

    const final = await getPostDetail(c.app, tenant.owner, tenant.workspaceId, postId);
    expect(final.rollup).toMatchObject({ kind: 'uniform', state: 'published' });
    for (const d of final.destinations) {
      expect(d.publishedMode).toBe('simulated');
      expect(d.externalId).toMatch(/^sim_/);
      expect(d.permalink).toContain('simulator.relay.invalid');
      expect(new Date(d.publishedAt!).getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-12T09:30:00Z'));
    }
    const actions = final.timeline.map((t) => t.action);
    for (const expected of ['asset.validated', 'post.created', 'post.submitted', 'approval.approved', 'publish.scheduled', 'publish.dispatch_claimed', 'publication.confirmed']) {
      expect(actions).toContain(expected);
    }

    // Metrics: run the "latest" refresh the worker would run after confirmation.
    const pubs = await withTenant(c.worker.db, { workspaceId: tenant.workspaceId }, (tx) => tx.selectFrom('externalPublications').select(['id']).execute());
    expect(pubs).toHaveLength(2);
    clock.advance(26 * 3600_000);
    for (const p of pubs) {
      expect(await refreshMetrics(c.worker, { workspaceId: tenant.workspaceId, externalPublicationId: p.id, ageBucket: '24h' })).toBe('ok');
      // Idempotent: a duplicate delivery does not create duplicate observations.
      expect(await refreshMetrics(c.worker, { workspaceId: tenant.workspaceId, externalPublicationId: p.id, ageBucket: '24h' })).toBe('ok');
    }
    const results = await getResults(c.app, tenant.owner, tenant.workspaceId, { pageId: tenant.pageId });
    expect(results.totals).toEqual({ publications: 2, simulated: 2, live: 0 });
    const views = results.panels.find((p) => p.definition.metricKey === 'views')!;
    expect(views.simulated).toBe(true);
    expect(views.byAge.find((a) => a.ageKey === 'age:24h')).toMatchObject({ cohortSize: 2, available: 2 });
    const saves = results.panels.find((p) => p.definition.metricKey === 'saves')!;
    // YouTube (simulated) does not report saves; Instagram does — never coerced to zero.
    expect(saves.byAge.find((a) => a.ageKey === 'age:24h')).toMatchObject({ available: 1, unavailableReasons: ['Not reported by this platform'] });
  });
});
