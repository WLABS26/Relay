import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { ManualClock } from '@relay/domain';
import {
  acceptInvitation,
  createClip,
  createPostFromClip,
  decideApprovals,
  exportClip,
  getAsset,
  getClip,
  getPostDetail,
  inviteMember,
  requestClipRender,
  revokeRightsGrant,
  scheduleDestination,
  submitPost,
  updateClip,
  type AuthenticatedUser,
} from '@relay/services';
import { processClipRender } from '@relay/services/clip-render';
import {
  createTenant,
  createUser,
  destinationState,
  drivePublishing,
  expectAppError,
  makeContexts,
  meta,
  renderClipOf,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

const ATTEMPT = { number: 1, max: 3 };
const LAST_ATTEMPT = { number: 3, max: 3 };

describe('clip hand-off: a rendered clip becomes a draft post and follows the publish flow (M2)', () => {
  const clock = new ManualClock('2026-11-12T08:00:00Z'); // Thursday 09:00 Europe/Berlin
  let c: Contexts;
  let t: Tenant;
  let scratch: string;
  let timecode: string;

  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(c.app.db, { workspaceId: t.workspaceId }, fn);
  const upload = async () =>
    (await uploadFixture(c, t, t.owner, 'timecode-30fps.mp4', 'video/mp4')).assetId;
  const destinationId = (key: string) => t.destinations[key]!.pageDestinationId;
  const revoke = async (sourceId: string) => {
    const asset = await getAsset(c.app, t.owner, t.workspaceId, sourceId);
    return revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: asset.grants[0]!.id, reason: 'Licence ended' },
      meta,
    );
  };
  const postCount = async () =>
    Number(
      (
        await inTenant((tx) =>
          tx
            .selectFrom('posts')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow(),
        )
      ).n,
    );
  const postMedia = (revisionId: string) =>
    inTenant((tx) =>
      tx
        .selectFrom('postRevisionMedia')
        .select(['assetId', 'position'])
        .where('revisionId', '=', revisionId)
        .orderBy('position', 'asc')
        .execute(),
    );
  const handedOff = async (clipId: string) =>
    (
      await inTenant((tx) =>
        tx
          .selectFrom('auditEvents')
          .select(['data', 'postId'])
          .where('entityId', '=', clipId)
          .where('action', '=', 'clip.handed_off')
          .orderBy('id', 'asc')
          .execute(),
      )
    ).map((e) => ({ postId: e.postId, data: e.data as Record<string, unknown> }));
  const remotePublished = async (postDestinationId: string) =>
    (
      await c.worker.db
        .selectFrom('providerSim.remotePosts')
        .select(['status'])
        .where('operationId', 'like', `${t.workspaceId}:${postDestinationId}:%`)
        .execute()
    ).filter((r) => r.status === 'published');

  const handOff = (clipId: string, key: string, user: AuthenticatedUser = t.owner) =>
    createPostFromClip(
      c.app,
      user,
      t.workspaceId,
      clipId,
      { destinationIds: [destinationId(key)], caption: 'Sample caption: clipped highlight' },
      meta,
    );
  const submit = (postId: string) => submitPost(c.app, t.owner, t.workspaceId, postId, {}, meta);
  const approve = async (postId: string) => {
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, postId);
    return decideApprovals(
      c.app,
      t.owner,
      t.workspaceId,
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
  };
  const schedule = async (postId: string) => {
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, postId);
    const d = detail.destinations[0]!;
    return scheduleDestination(
      c.app,
      t.owner,
      t.workspaceId,
      d.id,
      { expectedVersion: d.version, mode: 'asap' },
      meta,
    );
  };
  /** A rendered clip of its own source, handed off, submitted and approved. */
  async function approvedClipPost(key: string, range = { startMs: 0, endMs: 1000 }) {
    const sourceId = await upload();
    const r = await renderClipOf(c, t, t.owner, sourceId, range);
    expect(r.outcome).toBe('succeeded');
    const post = await handOff(r.clipId, key);
    expect((await submit(post.body.postId)).outcomes.map((o) => o.ok)).toEqual([true]);
    expect((await approve(post.body.postId)).outcomes.map((o) => o.error ?? o.state)).toEqual([
      'approved',
    ]);
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, post.body.postId);
    return {
      sourceId,
      ...r,
      postId: post.body.postId,
      postDestinationId: detail.destinations[0]!.id,
    };
  }

  async function join(role: 'editor' | 'viewer'): Promise<AuthenticatedUser> {
    const user = await createUser(c.app, { name: `${role} user` });
    const invite = await inviteMember(
      c.app,
      t.owner,
      t.workspaceId,
      { email: user.email, role, allPages: true, pageIds: [] },
      meta,
    );
    await acceptInvitation(c.app, user, { token: invite.token }, meta);
    return user;
  }

  beforeAll(async () => {
    c = makeContexts({ clock });
    // One simulated account per publishing test, so the minimum gap between posts on an
    // account never decides an outcome here.
    t = await createTenant(c.app, {
      accounts: ['publish', 'approve', 'schedule', 'dispatch', 'spare'].map((key) => ({
        key,
        provider: 'youtube' as const,
      })),
    });
    scratch = await mkdtemp(path.join(tmpdir(), 'relay-clip-handoff-test-'));
    timecode = await upload();
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await c.close();
  });

  it('hands a rendered clip to a draft that is approved, scheduled and published (simulated)', async () => {
    const r = await renderClipOf(c, t, t.owner, timecode, { startMs: 2000, endMs: 3000 });
    expect(r.outcome).toBe('succeeded');
    const source = await getAsset(c.app, t.owner, t.workspaceId, timecode);

    const post = await handOff(r.clipId, 'publish');
    expect(post.status).toBe(201);
    expect(post.replayed).toBe(false);
    expect(post.body).toMatchObject({ clipId: r.clipId, assetId: r.outputAssetId });
    // The draft holds the rendered asset, never the source.
    expect(await postMedia(post.body.revisionId)).toEqual([
      { assetId: r.outputAssetId, position: 0 },
    ]);
    expect(await handedOff(r.clipId)).toEqual([
      {
        postId: post.body.postId,
        data: {
          postId: post.body.postId,
          renderJobId: r.renderJobId,
          revisionId: r.revisionId,
          assetId: r.outputAssetId,
        },
      },
    ]);
    const draft = await getPostDetail(c.app, t.owner, t.workspaceId, post.body.postId);
    expect(draft.destinations.map((d) => d.state)).toEqual(['draft']);
    // Nothing was approved or scheduled by the hand-off itself.
    expect(await remotePublished(draft.destinations[0]!.id)).toEqual([]);

    expect((await submit(post.body.postId)).outcomes.map((o) => o.ok)).toEqual([true]);
    expect((await approve(post.body.postId)).outcomes.map((o) => o.error ?? o.state)).toEqual([
      'approved',
    ]);
    expect((await schedule(post.body.postId)).body.state).toBe('scheduled');
    clock.advance(10_000);
    const run = await drivePublishing(c, t.workspaceId, draft.destinations[0]!.id);
    expect(run.state, run.steps.join(' → ')).toBe('published');

    const final = await getPostDetail(c.app, t.owner, t.workspaceId, post.body.postId);
    expect(final.rollup).toMatchObject({ kind: 'uniform', state: 'published' });
    // Simulated is never "live".
    expect(final.destinations[0]).toMatchObject({ publishedMode: 'simulated' });
    expect(final.destinations[0]!.externalId).toMatch(/^sim_/);
    expect(await remotePublished(draft.destinations[0]!.id)).toHaveLength(1);
    const actions = final.timeline.map((e) => e.action);
    for (const expected of [
      'post.created',
      'clip.handed_off',
      'post.submitted',
      'approval.approved',
      'publish.scheduled',
      'publication.confirmed',
    ])
      expect(actions).toContain(expected);
    // The source was only read.
    const sourceAfter = await getAsset(c.app, t.owner, t.workspaceId, timecode);
    expect(sourceAfter.asset).toEqual(source.asset);
  });

  it('defaults to every enabled destination of the page and replays an Idempotency-Key', async () => {
    const r = await renderClipOf(c, t, t.owner, timecode, { startMs: 3000, endMs: 4000 });
    const keyed = { ...meta, idempotencyKey: `handoff-${r.clipId}` };
    const before = await postCount();
    const first = await createPostFromClip(c.app, t.owner, t.workspaceId, r.clipId, {}, keyed);
    expect(first.status).toBe(201);
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, first.body.postId);
    expect(detail.destinations.map((d) => d.pageDestinationId).sort()).toEqual(
      Object.values(t.destinations)
        .map((d) => d.pageDestinationId)
        .sort(),
    );
    // The clip's title is the draft's title unless one is given.
    expect(detail.revision.title).toBe(
      (await getClip(c.app, t.owner, t.workspaceId, r.clipId)).clip.title,
    );

    const again = await createPostFromClip(c.app, t.owner, t.workspaceId, r.clipId, {}, keyed);
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    expect(await postCount()).toBe(before + 1);
    expect(await handedOff(r.clipId)).toHaveLength(1);
    // The same key with another request is refused, not answered with the first draft.
    await expectAppError(
      createPostFromClip(c.app, t.owner, t.workspaceId, r.clipId, { caption: 'Other' }, keyed),
      'idempotency_key_reused',
    );
    // The page is the clip's; it cannot be chosen by the caller.
    await expect(
      createPostFromClip(c.app, t.owner, t.workspaceId, r.clipId, { pageId: t.pageId }, meta),
    ).rejects.toThrow(/Unrecognized key/);
  });

  it('refuses a hand-off before the render finished, after it failed, and after an edit', async () => {
    const before = await postCount();
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      timecode,
      { startMs: 4000, endMs: 5000 },
      { process: false },
    );
    const queued = await expectAppError(handOff(r.clipId, 'spare'), 'media_not_ready');
    expect(queued.message).toBe('This clip is still being rendered.');

    const broken = {
      ...c.worker,
      config: {
        ...c.worker.config,
        media: { ...c.worker.config.media, scratchDir: path.join(scratch, 'missing') },
      },
    };
    expect(
      await processClipRender(
        broken,
        { workspaceId: t.workspaceId, renderJobId: r.renderJobId },
        LAST_ATTEMPT,
      ),
    ).toBe('failed');
    const failed = await expectAppError(handOff(r.clipId, 'spare'), 'media_not_ready');
    expect(failed.message).toBe('The last render of this clip failed. Render it again.');
    // A failed render cannot be exported either.
    await expectAppError(
      exportClip(c.app, t.owner, t.workspaceId, r.clipId, meta),
      'media_not_ready',
    );

    // Rendered again, then edited: the stored render no longer shows the clip.
    const retry = await requestClipRender(c.app, t.owner, t.workspaceId, r.clipId, {}, meta);
    expect(retry.status).toBe(202);
    expect(
      await processClipRender(
        c.worker,
        { workspaceId: t.workspaceId, renderJobId: retry.body.renderJobId },
        ATTEMPT,
      ),
    ).toBe('succeeded');
    const clip = await getClip(c.app, t.owner, t.workspaceId, r.clipId);
    await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      r.clipId,
      {
        version: clip.clip.version,
        startMs: 4000,
        endMs: 5500,
        aspect: '9:16',
        cropMode: 'fill',
        captions: null,
      },
      meta,
    );
    const edited = await expectAppError(handOff(r.clipId, 'spare'), 'media_not_ready');
    expect(edited.message).toMatch(/edited after its last render/);

    const unrendered = await createClip(
      c.app,
      t.owner,
      t.workspaceId,
      { sourceAssetId: timecode, startMs: 6000, endMs: 7000 },
      meta,
    );
    const none = await expectAppError(handOff(unrendered.body.clipId, 'spare'), 'media_not_ready');
    expect(none.message).toBe('Render this clip first.');
    expect(await postCount()).toBe(before);
    expect(await handedOff(r.clipId)).toEqual([]);
  });

  it('hands off a clip whose render is shared with an identical edit', async () => {
    // Two clips with the same edit of the same source are rendered once.
    const first = await renderClipOf(c, t, t.owner, timecode, { startMs: 7000, endMs: 8000 });
    expect(first.outcome).toBe('succeeded');
    const twin = await renderClipOf(c, t, t.owner, timecode, { startMs: 7000, endMs: 8000 });
    expect(twin.requested.status).toBe(200);
    expect(twin.requested.body).toMatchObject({
      renderJobId: first.renderJobId,
      outputAssetId: first.outputAssetId,
      clipId: twin.clipId,
      revisionId: twin.revisionId,
      status: 'succeeded',
    });
    const twinDetail = await getClip(c.app, t.owner, t.workspaceId, twin.clipId);
    expect(twinDetail.latestRender).toMatchObject({
      id: first.renderJobId,
      revisionId: twin.revisionId,
      status: 'succeeded',
      outputAssetId: first.outputAssetId,
      outputAssetStatus: 'ready',
    });
    const post = await handOff(twin.clipId, 'spare');
    expect(post.body).toMatchObject({ clipId: twin.clipId, assetId: first.outputAssetId });
    const exported = await exportClip(c.app, t.owner, t.workspaceId, twin.clipId, meta);
    expect(exported).toMatchObject({ assetId: first.outputAssetId, revisionId: twin.revisionId });

    // An edit that is taken back: the clip returns to an edit it already rendered, and the
    // newest job of the clip is for the edit in between.
    const save = async (endMs: number) => {
      const clip = await getClip(c.app, t.owner, t.workspaceId, first.clipId);
      return updateClip(
        c.app,
        t.owner,
        t.workspaceId,
        first.clipId,
        {
          version: clip.clip.version,
          startMs: 7000,
          endMs,
          aspect: '9:16',
          cropMode: 'fill',
          captions: null,
        },
        meta,
      );
    };
    await save(8500);
    const between = await requestClipRender(c.app, t.owner, t.workspaceId, first.clipId, {}, meta);
    expect(between.status).toBe(202);
    expect(
      await processClipRender(
        c.worker,
        { workspaceId: t.workspaceId, renderJobId: between.body.renderJobId },
        ATTEMPT,
      ),
    ).toBe('succeeded');
    const back = await save(8000);
    expect(back.revisionCreated).toBe(true);
    const rerender = await requestClipRender(c.app, t.owner, t.workspaceId, first.clipId, {}, meta);
    expect(rerender.status).toBe(200);
    expect(rerender.body).toMatchObject({
      renderJobId: first.renderJobId,
      outputAssetId: first.outputAssetId,
      revisionId: back.revision.id,
    });
    const reverted = await handOff(first.clipId, 'spare');
    expect(reverted.body.assetId).toBe(first.outputAssetId);
    expect(await postMedia(reverted.body.revisionId)).toEqual([
      { assetId: first.outputAssetId, position: 0 },
    ]);
    expect((await getClip(c.app, t.owner, t.workspaceId, first.clipId)).latestRender).toMatchObject(
      { id: first.renderJobId, revisionId: back.revision.id },
    );
  });

  it('rights revoked on the source block the clip post at submit and at approval', async () => {
    const sourceId = await upload();
    const r = await renderClipOf(c, t, t.owner, sourceId, { startMs: 0, endMs: 1000 });
    const submitted = await handOff(r.clipId, 'approve');
    expect((await submit(submitted.body.postId)).outcomes.map((o) => o.ok)).toEqual([true]);
    const draft = await handOff(r.clipId, 'spare');

    // The grant is the source's: the clip has none of its own to keep it alive.
    expect((await revoke(sourceId)).assetId).toBe(sourceId);

    const approval = await approve(submitted.body.postId);
    expect(approval.outcomes.map((o) => o.ok)).toEqual([false]);
    expect(approval.outcomes[0]!.error).toMatchObject({
      code: 'destination_validation_failed',
      message: 'The rights for this media were revoked.',
    });
    const pending = await getPostDetail(c.app, t.owner, t.workspaceId, submitted.body.postId);
    expect(pending.destinations.map((d) => d.state)).not.toContain('approved');

    const refused = await submit(draft.body.postId);
    expect(refused.outcomes.map((o) => o.ok)).toEqual([false]);
    expect(JSON.stringify(refused.outcomes)).toContain('rights_missing');
    const still = await getPostDetail(c.app, t.owner, t.workspaceId, draft.body.postId);
    expect(still.destinations.map((d) => d.state)).toEqual(['draft']);
  });

  it('rights revoked after approval block scheduling the clip post', async () => {
    const p = await approvedClipPost('schedule');
    await revoke(p.sourceId);
    // The approval covered the grant that is now revoked.
    await expectAppError(schedule(p.postId), 'approval_stale');
    const after = await destinationState(c.app, t.workspaceId, p.postDestinationId);
    expect(after.state).not.toBe('scheduled');
    expect(after.activeIntentId).toBeNull();
    expect(await remotePublished(p.postDestinationId)).toEqual([]);
  });

  it('rights revoked after scheduling block dispatch: nothing is sent (M2 gate)', async () => {
    const p = await approvedClipPost('dispatch');
    expect((await schedule(p.postId)).body.state).toBe('scheduled');
    clock.advance(10_000);
    // Private preparation has started when the rights holder withdraws consent.
    const prepared = await drivePublishing(c, t.workspaceId, p.postDestinationId, { maxSteps: 1 });
    expect(prepared.steps).toEqual(['prepare:continue']);
    await revoke(p.sourceId);

    const run = await drivePublishing(c, t.workspaceId, p.postDestinationId);
    expect(run.state, run.steps.join(' → ')).toBe('blocked');
    expect(run.steps).not.toContain('dispatch:continue');
    const blocked = await destinationState(c.app, t.workspaceId, p.postDestinationId);
    expect(blocked.stateReason).toBe('rights_changed');
    expect(await remotePublished(p.postDestinationId)).toEqual([]);
    const detail = await getPostDetail(c.app, t.owner, t.workspaceId, p.postId);
    expect(detail.destinations[0]).toMatchObject({ state: 'blocked', publishedMode: null });
    // Driving it again changes nothing: the block is not a retry.
    expect((await drivePublishing(c, t.workspaceId, p.postDestinationId)).state).toBe('blocked');
    expect(await remotePublished(p.postDestinationId)).toEqual([]);
  });

  it('hides the hand-off from other tenants, from viewers and from foreign destinations', async () => {
    const r = await renderClipOf(c, t, t.owner, timecode, { startMs: 8000, endMs: 9000 });
    expect(r.outcome).toBe('succeeded');
    const before = await postCount();
    const other = await createTenant(c.app);
    await expectAppError(
      createPostFromClip(c.app, other.owner, other.workspaceId, r.clipId, {}, meta),
      'not_found',
    );
    // A member of another workspace is not a member here.
    await expectAppError(
      createPostFromClip(c.app, other.owner, t.workspaceId, r.clipId, {}, meta),
      'not_found',
    );
    await expectAppError(handOff(r.clipId, 'spare', await join('viewer')), 'forbidden');
    // A destination of another tenant's page cannot be attached to this clip's post.
    await expectAppError(
      createPostFromClip(
        c.app,
        t.owner,
        t.workspaceId,
        r.clipId,
        { destinationIds: [other.destinations.youtube!.pageDestinationId] },
        meta,
      ),
      'validation_failed',
    );
    expect(await postCount()).toBe(before);
    expect(await handedOff(r.clipId)).toEqual([]);

    const editor = await join('editor');
    const post = await handOff(r.clipId, 'spare', editor);
    expect(post.status).toBe(201);
  });
});
