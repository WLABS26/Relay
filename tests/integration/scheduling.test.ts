import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { DEFAULT_PUBLISHING_RULES, ManualClock } from '@relay/domain';
import {
  getCalendar,
  getPostDetail,
  putPublishingRules,
  recommendSlotsFor,
  scheduleDestination,
  setPagePaused,
  setSlotLock,
  unscheduleDestination,
  updatePage,
  updatePost,
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

describe('scheduling: time zones, pacing and concurrency (M1 gate)', () => {
  const clock = new ManualClock('2026-03-25T08:00:00Z');
  let c: Contexts;
  let t: Tenant;
  let asset: string;

  beforeAll(async () => {
    c = makeContexts({ clock });
    t = await createTenant(c.app, {
      accounts: [
        { key: 'yt', provider: 'youtube' },
        { key: 'ig', provider: 'instagram' },
      ],
    });
    asset = (await uploadFixture(c, t, t.owner, 'vertical-1080x1920-8s.mp4', 'video/mp4')).assetId;
  });
  afterAll(async () => c.close());

  const schedule = (
    id: string,
    version: number,
    localTime: string,
    offset?: string,
    extra: Record<string, unknown> = {},
  ) =>
    scheduleDestination(
      c.app,
      t.owner,
      t.workspaceId,
      id,
      { expectedVersion: version, mode: 'at', localTime, ...(offset ? { offset } : {}), ...extra },
      meta,
    );

  it('rejects a nonexistent spring-forward time with a valid suggestion', async () => {
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const error = await expectAppError(
      schedule(p.destinations.yt!.id, p.destinations.yt!.version, '2026-03-29T02:30'),
      'nonexistent_local_time',
    );
    expect(error.details?.suggestion).toMatchObject({
      civil: '2026-03-29T03:30',
      offset: '+02:00',
    });
  });

  it('requires an explicit offset for an ambiguous fall-back time, then honours it', async () => {
    clock.set('2026-10-20T08:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const d = p.destinations.yt!;
    const error = await expectAppError(
      schedule(d.id, d.version, '2026-10-25T02:30'),
      'ambiguous_local_time',
    );
    expect(error.details?.options).toEqual([
      { instant: '2026-10-25T00:30:00Z', offset: '+02:00' },
      { instant: '2026-10-25T01:30:00Z', offset: '+01:00' },
    ]);
    // Once the fold is resolved, the page's default quiet hours (23:00–07:00) still apply.
    await expectAppError(schedule(d.id, d.version, '2026-10-25T02:30', '+01:00'), 'quiet_hours');
    // A new policy revision without quiet hours allows it; existing rules are versioned.
    const { revision } = await putPublishingRules(
      c.app,
      t.owner,
      t.workspaceId,
      t.pageId,
      { expectedRevision: 1, rules: { ...DEFAULT_PUBLISHING_RULES, quietHours: [] } },
      meta,
    );
    expect(revision).toBe(2);
    const second = await schedule(d.id, d.version, '2026-10-25T02:30', '+01:00');
    expect(second.body).toMatchObject({
      plannedAt: '2026-10-25T01:30:00.000Z',
      civil: '2026-10-25T02:30',
      offset: '+01:00',
      zone: 'Europe/Berlin',
    });
    await putPublishingRules(
      c.app,
      t.owner,
      t.workspaceId,
      t.pageId,
      { expectedRevision: 2, rules: DEFAULT_PUBLISHING_RULES },
      meta,
    );
  });

  it('serialises concurrent schedules for the same account: exact slot and minimum gap', async () => {
    clock.set('2026-11-02T08:00:00Z');
    const p1 = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const p2 = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const p3 = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    // Same instant, in parallel: exactly one wins.
    const exact = await Promise.allSettled([
      schedule(p1.destinations.yt!.id, p1.destinations.yt!.version, '2026-11-04T10:00'),
      schedule(p2.destinations.yt!.id, p2.destinations.yt!.version, '2026-11-04T10:00'),
    ]);
    expect(exact.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = exact.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['slot_conflict', 'min_gap_violation']).toContain(loser.reason.code);
    // Within the 120-minute minimum gap, in parallel with nothing else: rejected.
    await expectAppError(
      schedule(p3.destinations.yt!.id, p3.destinations.yt!.version, '2026-11-04T11:15'),
      'min_gap_violation',
    );
    // A different account at the same instant is fine.
    const ig = await approvedPost(c, t, { destinationKeys: ['ig'], assetIds: [asset] });
    expect(
      (await schedule(ig.destinations.ig!.id, ig.destinations.ig!.version, '2026-11-04T10:00')).body
        .state,
    ).toBe('scheduled');
  });

  it('enforces quiet hours and campaign-independent daily caps', async () => {
    clock.set('2026-11-09T07:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    await expectAppError(
      schedule(p.destinations.yt!.id, p.destinations.yt!.version, '2026-11-10T23:30'),
      'quiet_hours',
    );
  });

  it('moves a scheduled post atomically, refuses to move a locked slot, and cancels cleanly', async () => {
    clock.set('2026-11-16T07:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const d = p.destinations.yt!;
    const first = await schedule(d.id, d.version, '2026-11-17T09:00');
    const moved = await schedule(d.id, first.body.version, '2026-11-17T17:00');
    expect(moved.body.intentVersion).toBe(2);
    const calendar = await getCalendar(c.app, t.owner, t.workspaceId, {
      from: '2026-11-17',
      to: '2026-11-17',
      pageId: t.pageId,
    });
    expect(
      calendar.items.filter((i) => i.postDestinationId === d.id).map((i) => i.localTime),
    ).toEqual(['17:00']);
    const lock = await setSlotLock(
      c.app,
      t.owner,
      t.workspaceId,
      d.id,
      { expectedVersion: moved.body.version, locked: true },
      meta,
    );
    await expectAppError(schedule(d.id, lock.version, '2026-11-18T09:00'), 'slot_locked');
    const canceled = await unscheduleDestination(
      c.app,
      t.owner,
      t.workspaceId,
      d.id,
      { expectedVersion: lock.version },
      meta,
    );
    expect(canceled.state).toBe('approved');
    const after = await getCalendar(c.app, t.owner, t.workspaceId, {
      from: '2026-11-17',
      to: '2026-11-18',
      pageId: t.pageId,
    });
    expect(after.items.some((i) => i.postDestinationId === d.id)).toBe(false);
    // Optimistic concurrency: a stale version is refused.
    await expectAppError(schedule(d.id, lock.version, '2026-11-18T09:00'), 'version_conflict');
  });

  it('keeps existing UTC instants when the page time zone changes', async () => {
    clock.set('2026-11-23T07:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const s = await schedule(p.destinations.yt!.id, p.destinations.yt!.version, '2026-11-24T09:00');
    const page = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.selectFrom('pages').select('version').where('id', '=', t.pageId).executeTakeFirstOrThrow(),
    );
    await updatePage(
      c.app,
      t.owner,
      t.workspaceId,
      t.pageId,
      { expectedVersion: page.version, timezone: 'America/New_York' },
      meta,
    );
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, p.postId);
    expect(detail.destinations[0]!.plannedAt!.toISOString()).toBe(s.body.plannedAt);
    expect(detail.destinations[0]!.civilZone).toBe('Europe/Berlin'); // the zone the user chose is recorded
    const page2 = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx.selectFrom('pages').select('version').where('id', '=', t.pageId).executeTakeFirstOrThrow(),
    );
    await updatePage(
      c.app,
      t.owner,
      t.workspaceId,
      t.pageId,
      { expectedVersion: page2.version, timezone: 'Europe/Berlin' },
      meta,
    );
  });

  it('recommends cold-start slots inside posting windows without reserving anything', async () => {
    clock.set('2026-11-30T06:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const rec = await recommendSlotsFor(c.app, t.owner, t.workspaceId, {
      postDestinationIds: [p.destinations.yt!.id],
      count: 3,
    });
    const r = rec.results[0]!;
    expect(r.algorithmVersion).toBe('cold-start-windows@1');
    expect(r.suggestions).toHaveLength(3);
    for (const s of r.suggestions) {
      expect(s.coldStart).toBe(true);
      expect(s.sampleSize).toBe(0);
      expect(s.reasons[0]).toMatch(/posting window/);
    }
    const state = await destinationState(c.app, t.workspaceId, p.destinations.yt!.id);
    expect(state.state).toBe('approved');
    expect(state.activeIntentId).toBeNull();
  });

  it('pause before the claim blocks dispatch; resume continues; a claim before the pause stays in flight', async () => {
    clock.set('2026-12-07T08:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const d = p.destinations.yt!;
    await schedule(d.id, d.version, '2026-12-07T09:30'); // 08:30Z
    await setPagePaused(c.app, t.owner, t.workspaceId, t.pageId, true, 'Brand review', meta);
    const blocked = await drivePublishing(c, t.workspaceId, d.id);
    expect(blocked.state).toBe('blocked');
    expect((await destinationState(c.app, t.workspaceId, d.id)).stateReason).toBe('page_paused');
    const resumed = await setPagePaused(
      c.app,
      t.owner,
      t.workspaceId,
      t.pageId,
      false,
      undefined,
      meta,
    );
    expect(resumed.resumed).toBe(1);
    const run = await drivePublishing(c, t.workspaceId, d.id);
    expect(run.state, run.steps.join(' → ')).toBe('published');

    // In flight: advance until the dispatch claim commits, then pause, then finish.
    clock.set('2026-12-14T08:00:00Z');
    const q = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    await schedule(q.destinations.yt!.id, q.destinations.yt!.version, '2026-12-14T09:30');
    const { advancePublish } = await import('@relay/services');
    const intent = await withTenant(c.worker.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .selectFrom('postDestinations as pd')
        .innerJoin('publishIntents as i', 'i.id', 'pd.activeIntentId')
        .select(['i.id', 'i.intentVersion'])
        .where('pd.id', '=', q.destinations.yt!.id)
        .executeTakeFirstOrThrow(),
    );
    const payload = {
      workspaceId: t.workspaceId,
      postDestinationId: q.destinations.yt!.id,
      intentId: intent.id,
      intentVersion: intent.intentVersion,
    };
    for (let i = 0; i < 3; i++) await advancePublish(c.worker, payload, { workerId: 'w1' }); // prepare, transfer, wait
    clock.set('2026-12-14T08:30:01Z');
    // Dispatch: claim commits, then the provider call and the fenced commit.
    const dispatched = await advancePublish(c.worker, payload, { workerId: 'w1' });
    expect(dispatched).toMatchObject({ kind: 'step', phase: 'dispatch', result: 'continue' });
    const pause = await setPagePaused(
      c.app,
      t.owner,
      t.workspaceId,
      t.pageId,
      true,
      'Late pause',
      meta,
    );
    expect(pause.inFlight).toEqual([
      { postDestinationId: q.destinations.yt!.id, state: 'dispatching' },
    ]);
    const finish = await drivePublishing(c, t.workspaceId, q.destinations.yt!.id);
    expect(finish.state).toBe('published');
    await setPagePaused(c.app, t.owner, t.workspaceId, t.pageId, false, undefined, meta);
  });

  it('editing approved content invalidates only destinations whose intent changed', async () => {
    clock.set('2026-12-21T07:00:00Z');
    const p = await approvedPost(c, t, {
      destinationKeys: ['yt', 'ig'],
      assetIds: [asset],
      caption: 'Original caption',
    });
    const scheduled = await schedule(
      p.destinations.yt!.id,
      p.destinations.yt!.version,
      '2026-12-22T09:00',
    );
    expect(scheduled.body.state).toBe('scheduled');
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, p.postId);
    const igDest = t.destinations.ig!.pageDestinationId;
    // Change only the Instagram caption via a variant: YouTube's intent is unchanged.
    const edit = await updatePost(
      c.app,
      t.owner,
      t.workspaceId,
      p.postId,
      {
        expectedVersion: detail.post.version,
        title: 'Sample post',
        caption: 'Original caption',
        mediaAssetIds: [asset],
        variants: { [igDest]: { caption: 'Instagram-only caption' } },
      },
      meta,
    );
    const yt = edit.destinations.find((o) => o.postDestinationId === p.destinations.yt!.id)!;
    const ig = edit.destinations.find((o) => o.postDestinationId === p.destinations.ig!.id)!;
    expect(yt).toMatchObject({ approvalKept: true, state: 'scheduled' });
    expect(ig).toMatchObject({ approvalKept: false, state: 'draft' });
    // A real change to the shared caption unschedules YouTube and requires re-approval.
    const edit2 = await updatePost(
      c.app,
      t.owner,
      t.workspaceId,
      p.postId,
      {
        expectedVersion: edit.version,
        title: 'Sample post',
        caption: 'Changed for everyone',
        mediaAssetIds: [asset],
      },
      meta,
    );
    expect(
      edit2.destinations.find((o) => o.postDestinationId === p.destinations.yt!.id),
    ).toMatchObject({ approvalKept: false, state: 'draft' });
    const cal = await getCalendar(c.app, t.owner, t.workspaceId, {
      from: '2026-12-22',
      to: '2026-12-22',
      pageId: t.pageId,
    });
    expect(cal.items.some((i) => i.postDestinationId === p.destinations.yt!.id)).toBe(false);
    // Stale optimistic version.
    await expectAppError(
      updatePost(
        c.app,
        t.owner,
        t.workspaceId,
        p.postId,
        { expectedVersion: edit.version, caption: 'x', mediaAssetIds: [asset] },
        meta,
      ),
      'version_conflict',
    );
  });

  it('returns the original response for a repeated Idempotency-Key and rejects a reused key', async () => {
    clock.set('2026-12-28T07:00:00Z');
    const p = await approvedPost(c, t, { destinationKeys: ['yt'], assetIds: [asset] });
    const d = p.destinations.yt!;
    const body = { expectedVersion: d.version, mode: 'at' as const, localTime: '2026-12-29T09:00' };
    const key = 'idem-key-0001-schedule';
    const one = await scheduleDestination(c.app, t.owner, t.workspaceId, d.id, body, {
      ...meta,
      idempotencyKey: key,
    });
    const two = await scheduleDestination(c.app, t.owner, t.workspaceId, d.id, body, {
      ...meta,
      idempotencyKey: key,
    });
    expect(two.replayed).toBe(true);
    expect(two.body).toEqual(JSON.parse(JSON.stringify(one.body)));
    await expectAppError(
      scheduleDestination(
        c.app,
        t.owner,
        t.workspaceId,
        d.id,
        { ...body, localTime: '2026-12-29T11:00' },
        { ...meta, idempotencyKey: key },
      ),
      'idempotency_key_reused',
    );
  });
});
