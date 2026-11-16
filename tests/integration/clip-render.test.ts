import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { clipGeometry } from '@relay/domain';
import {
  assetVariantKey,
  CLIP_RENDERER_VERSION,
  runToolOrThrow,
  type ObjectStorage,
} from '@relay/media';
import { TIMECODE_FIXTURE, timecodeFrameFromLuma } from '@relay/media/fixtures';
import {
  acceptInvitation,
  createClip,
  evaluateRights,
  exportClip,
  getAsset,
  getClip,
  getJobRun,
  inviteMember,
  mediaUrl,
  requestClipRender,
  revokeRightsGrant,
  updateClip,
  type AuthenticatedUser,
  type ServiceContext,
} from '@relay/services';
import { clipReservedBytes, processClipRender } from '@relay/services/clip-render';
import {
  createTenant,
  createUser,
  expectAppError,
  fetchAll,
  makeContexts,
  meta,
  renderClipOf,
  testConfig,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

const ATTEMPT = { number: 1, max: 3 };
const LAST_ATTEMPT = { number: 3, max: 3 };

describe('clip.render: a clip revision becomes a derived asset (M2)', () => {
  let c: Contexts;
  let t: Tenant;
  let scratch: string;
  let timecode: string;

  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2], ctx: ServiceContext = c.app) =>
    withTenant(ctx.db, { workspaceId: t.workspaceId }, fn);
  const assetRow = (assetId: string) =>
    inTenant((tx) =>
      tx.selectFrom('mediaAssets').selectAll().where('id', '=', assetId).executeTakeFirstOrThrow(),
    );
  const jobRow = (renderJobId: string) =>
    inTenant((tx) =>
      tx
        .selectFrom('renderJobs')
        .selectAll()
        .where('id', '=', renderJobId)
        .executeTakeFirstOrThrow(),
    );
  const variantRows = (assetId: string) =>
    inTenant((tx) =>
      tx
        .selectFrom('mediaVariants')
        .selectAll()
        .where('assetId', '=', assetId)
        .orderBy('kind', 'asc')
        .execute(),
    );
  const usageRows = (renderJobId: string) =>
    inTenant((tx) =>
      tx
        .selectFrom('usageEvents')
        .select(['kind', 'quantity'])
        .where('entityId', '=', renderJobId)
        .orderBy('kind', 'asc')
        .execute(),
    );
  const auditActions = async (entityId: string) =>
    (
      await inTenant((tx) =>
        tx
          .selectFrom('auditEvents')
          .select(['action', 'id'])
          .where('entityId', '=', entityId)
          .orderBy('id', 'asc')
          .execute(),
      )
    ).map((e) => e.action);
  const variantKeys = (assetId: string) => [
    assetVariantKey(t.workspaceId, assetId, 1, 'thumbnail', 'jpg-640', 'jpg'),
    assetVariantKey(t.workspaceId, assetId, 1, 'proxy', 'h264-960', 'mp4'),
  ];
  const run = (renderJobId: string, attempt = ATTEMPT, ctx: ServiceContext = c.worker) =>
    processClipRender(ctx, { workspaceId: t.workspaceId, renderJobId }, attempt);
  const upload = async (name: string) =>
    (await uploadFixture(c, t, t.owner, name, 'video/mp4')).assetId;
  const grantId = async (assetId: string) =>
    (await getAsset(c.app, t.owner, t.workspaceId, assetId)).grants[0]!.id;

  /** The stored clip, fetched the way the worker would, as a local file and its hash. */
  async function fetchClip(assetId: string) {
    const asset = await assetRow(assetId);
    const file = path.join(await mkdtemp(path.join(scratch, 'clip-')), 'clip.mp4');
    const download = await c.worker.storage.downloadToFile({
      key: asset.objectKey,
      versionId: asset.objectVersionId,
      path: file,
      maxBytes: 64 * 1024 * 1024,
    });
    return { asset, file, ...download };
  }

  /** Mean luma of a region of every frame, read with `signalstats`. */
  async function regionLuma(file: string, crop: string): Promise<number[]> {
    const dir = await mkdtemp(path.join(scratch, 'stats-'));
    await runToolOrThrow(
      c.worker.config.media.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-vf',
        `crop=${crop},signalstats,metadata=mode=print:file=stats.txt`,
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: 60_000, usePrlimit: false },
      { cwd: dir },
    );
    const text = await readFile(path.join(dir, 'stats.txt'), 'utf8');
    return [...text.matchAll(/^lavfi\.signalstats\.YAVG=(.+)$/gm)].map((m) => Number(m[1]));
  }

  /** Source frame number shown by every frame of a clip cut from the timecode fixture. */
  async function timecodeFrames(file: string): Promise<number[]> {
    const left = await regionLuma(file, 'iw/2-16:ih:0:0');
    const right = await regionLuma(file, 'iw/2-16:ih:iw/2+16:0');
    expect(right).toHaveLength(left.length);
    return left.map((l, i) => timecodeFrameFromLuma(l, right[i] ?? NaN));
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
    c = makeContexts();
    t = await createTenant(c.app);
    scratch = await mkdtemp(path.join(tmpdir(), 'relay-clip-render-test-'));
    timecode = await upload('timecode-30fps.mp4');
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await c.close();
  });

  it('renders [2000, 5000) of the timecode source to exactly frames 60..149 as a ready derived asset', async () => {
    const sourceBefore = await assetRow(timecode);
    const sourceObjectBefore = await c.worker.storage.head(sourceBefore.objectKey);

    const r = await renderClipOf(c, t, t.owner, timecode, { startMs: 2000, endMs: 5000 });
    expect(r.requested.status).toBe(202);
    expect(r.requested.replayed).toBe(false);
    expect(r.requested.body.status).toBe('queued');
    expect(r.outcome).toBe('succeeded');

    const job = await jobRow(r.renderJobId);
    expect(job).toMatchObject({
      status: 'succeeded',
      clipId: r.clipId,
      revisionId: r.revisionId,
      sourceAssetId: timecode,
      outputAssetId: r.outputAssetId,
      profile: 'mp4-h264-aac',
      errorCode: null,
    });
    expect(job.rendererVersion).toContain(CLIP_RENDERER_VERSION);
    expect(job.rendererVersion).toMatch(/ffmpeg/i);
    expect(job.renderMs).toBeGreaterThanOrEqual(0);
    expect(job.outputProbe).toBeTruthy();
    expect(job.finishedAt).toBeInstanceOf(Date);

    const geometry = clipGeometry({
      sourceWidth: TIMECODE_FIXTURE.width,
      sourceHeight: TIMECODE_FIXTURE.height,
      aspect: '9:16',
      cropMode: 'fill',
    });
    const clip = await fetchClip(r.outputAssetId);
    expect(clip.asset).toMatchObject({
      status: 'ready',
      origin: 'render',
      kind: 'video',
      pageId: sourceBefore.pageId,
      declaredMime: 'video/mp4',
      detectedContainer: 'mp4',
      width: geometry.outWidth,
      height: geometry.outHeight,
      durationMs: 3000,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixFmt: 'yuv420p',
      rotation: 0,
      isSample: false,
      createdBy: t.owner.userId,
    });
    expect(Number(clip.asset.frameRate)).toBe(30);
    // The stored hash and size describe the stored bytes, not the reservation.
    expect(clip.asset.sha256).toBe(clip.sha256);
    expect(Number(clip.asset.sizeBytes)).toBe(clip.bytes);
    expect(clip.bytes).toBeLessThan(clipReservedBytes(3000, 512 * 1024 * 1024));
    expect(clip.asset.objectVersionId).toBeTruthy();

    // Start inclusive, end exclusive, no frame dropped or repeated.
    const frames = await timecodeFrames(clip.file);
    expect(frames).toEqual(Array.from({ length: 90 }, (_, i) => 60 + i));

    const variants = await variantRows(r.outputAssetId);
    expect(variants.map((v) => [v.kind, v.profile, v.mime])).toEqual([
      ['proxy', 'h264-960', 'video/mp4'],
      ['thumbnail', 'jpg-640', 'image/jpeg'],
    ]);
    for (const v of variants) expect(await c.worker.storage.head(v.objectKey)).not.toBeNull();

    // The source is only ever read: same row, same object version.
    expect(await assetRow(timecode)).toEqual(sourceBefore);
    expect(await c.worker.storage.head(sourceBefore.objectKey)).toEqual(sourceObjectBefore);
    // The derived asset has no grants of its own.
    const derivedGrants = await inTenant((tx) =>
      tx
        .selectFrom('sourceRightsGrants')
        .select('id')
        .where('assetId', '=', r.outputAssetId)
        .execute(),
    );
    expect(derivedGrants).toEqual([]);

    expect(await usageRows(r.renderJobId)).toEqual([
      { kind: 'export_bytes', quantity: `${clip.bytes}.000` },
      { kind: 'media_seconds_processed', quantity: '3.000' },
    ]);
    expect(await auditActions(r.renderJobId)).toEqual(['clip.render_requested', 'clip.rendered']);

    const jobRun = await getJobRun(c.app, t.owner, t.workspaceId, r.requested.body.jobId!);
    expect(jobRun.job).toMatchObject({ kind: 'clip.render', status: 'succeeded', progress: 100 });
    expect(jobRun.entity).toMatchObject({
      type: 'render_job',
      id: r.renderJobId,
      clipId: r.clipId,
      outputAssetId: r.outputAssetId,
      status: 'succeeded',
    });
    const detail = await getClip(c.app, t.owner, t.workspaceId, r.clipId);
    expect(detail.latestRender).toMatchObject({
      id: r.renderJobId,
      status: 'succeeded',
      outputAssetId: r.outputAssetId,
      outputAssetStatus: 'ready',
    });

    // The clip previews like an upload.
    const preview = await mediaUrl(c.app, t.owner, t.workspaceId, r.outputAssetId, 'proxy');
    const fetched = await fetchAll(preview.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('video/mp4');
  });

  it('returns the same job and asset for the same edit, and a second run of the handler changes nothing', async () => {
    const r = await renderClipOf(c, t, t.owner, timecode, { startMs: 1000, endMs: 2500 });
    expect(r.outcome).toBe('succeeded');
    const before = await assetRow(r.outputAssetId);

    const again = await requestClipRender(c.app, t.owner, t.workspaceId, r.clipId, {}, meta);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      renderJobId: r.renderJobId,
      outputAssetId: r.outputAssetId,
      jobId: r.requested.body.jobId,
      status: 'succeeded',
    });
    // Naming the current revision is the same request.
    const named = await requestClipRender(
      c.app,
      t.owner,
      t.workspaceId,
      r.clipId,
      { revisionId: r.revisionId },
      meta,
    );
    expect(named.body.renderJobId).toBe(r.renderJobId);
    // A second clip with the identical edit of the same source shares the render.
    const twin = await renderClipOf(c, t, t.owner, timecode, { startMs: 1000, endMs: 2500 });
    expect(twin.requested.status).toBe(200);
    expect(twin.outputAssetId).toBe(r.outputAssetId);
    expect(twin.outcome).toBe('skipped');

    expect(await run(r.renderJobId)).toBe('skipped');
    expect(await assetRow(r.outputAssetId)).toEqual(before);
    expect(await variantRows(r.outputAssetId)).toHaveLength(2);
    expect(await usageRows(r.renderJobId)).toHaveLength(2);
    const jobs = await inTenant((tx) =>
      tx.selectFrom('renderJobs').select('id').where('renderKey', '=', before.id).execute(),
    );
    expect(jobs).toEqual([]); // sanity: the key is a hash, not an ID
    const forKey = await inTenant(async (tx) => {
      const job = await tx
        .selectFrom('renderJobs')
        .select('renderKey')
        .where('id', '=', r.renderJobId)
        .executeTakeFirstOrThrow();
      return tx
        .selectFrom('renderJobs')
        .select('id')
        .where('renderKey', '=', job.renderKey)
        .execute();
    });
    expect(forKey).toEqual([{ id: r.renderJobId }]);
  });

  it('replays a request with the same Idempotency-Key and refuses the key for another clip', async () => {
    const created = await createClip(
      c.app,
      t.owner,
      t.workspaceId,
      { sourceAssetId: timecode, startMs: 7000, endMs: 8200 },
      meta,
    );
    const key = `render-${created.body.clipId}`;
    const first = await requestClipRender(
      c.app,
      t.owner,
      t.workspaceId,
      created.body.clipId,
      {},
      {
        ...meta,
        idempotencyKey: key,
      },
    );
    const replay = await requestClipRender(
      c.app,
      t.owner,
      t.workspaceId,
      created.body.clipId,
      {},
      {
        ...meta,
        idempotencyKey: key,
      },
    );
    expect(first.status).toBe(202);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    const other = await createClip(
      c.app,
      t.owner,
      t.workspaceId,
      { sourceAssetId: timecode, startMs: 7000, endMs: 8300 },
      meta,
    );
    await expectAppError(
      requestClipRender(
        c.app,
        t.owner,
        t.workspaceId,
        other.body.clipId,
        {},
        {
          ...meta,
          idempotencyKey: key,
        },
      ),
      'idempotency_key_reused',
    );
    expect(await run(first.body.renderJobId)).toBe('succeeded');
  });

  it('a redelivery after a crash adopts the clip already stored: one upload, one set of variants', async () => {
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      timecode,
      { startMs: 3000, endMs: 4000 },
      { process: false },
    );
    const output = await assetRow(r.outputAssetId);
    const scratchDir = await mkdtemp(path.join(scratch, 'worker-'));
    const config = { ...c.worker.config, media: { ...c.worker.config.media, scratchDir } };

    // The first delivery dies while storing the proxy: the clip and its thumbnail are stored.
    const real = c.worker.storage;
    const uploads: string[] = [];
    const flaky = Object.create(real) as ObjectStorage;
    flaky.uploadFile = async (input) => {
      if (input.key.includes('/proxy')) throw new Error('connection reset while storing the proxy');
      uploads.push(input.key);
      return real.uploadFile(input);
    };
    await expect(
      run(r.renderJobId, ATTEMPT, { ...c.worker, config, storage: flaky }),
    ).rejects.toThrow('connection reset');
    expect(uploads).toContain(output.objectKey);
    expect(await readdir(scratchDir)).toEqual([]);
    expect(await jobRow(r.renderJobId)).toMatchObject({ status: 'running' });
    expect(await assetRow(r.outputAssetId)).toMatchObject({ status: 'validating' });
    const storedFirst = await real.head(output.objectKey);
    expect(storedFirst).not.toBeNull();

    // The second delivery finds the job `running` and must finish it with what is stored.
    const counting = Object.create(real) as ObjectStorage;
    const second: string[] = [];
    counting.uploadFile = async (input) => {
      second.push(input.key);
      return real.uploadFile(input);
    };
    expect(
      await run(r.renderJobId, { number: 2, max: 3 }, { ...c.worker, config, storage: counting }),
    ).toBe('succeeded');
    expect(await readdir(scratchDir)).toEqual([]);
    expect(second).not.toContain(output.objectKey);

    const clip = await fetchClip(r.outputAssetId);
    expect(clip.asset.status).toBe('ready');
    expect(clip.asset.objectVersionId).toBe(storedFirst!.versionId);
    expect(clip.asset.sha256).toBe(clip.sha256);
    expect(await real.head(output.objectKey)).toEqual(storedFirst);
    expect(await timecodeFrames(clip.file)).toEqual(Array.from({ length: 30 }, (_, i) => 90 + i));
    expect(await variantRows(r.outputAssetId)).toHaveLength(2);
    expect(await usageRows(r.renderJobId)).toHaveLength(2);
    expect(await run(r.renderJobId)).toBe('skipped');
  });

  it('a new revision renders to a new key and a new asset; the first asset is untouched', async () => {
    const first = await renderClipOf(c, t, t.owner, timecode, { startMs: 5000, endMs: 6000 });
    expect(first.outcome).toBe('succeeded');
    const firstAsset = await assetRow(first.outputAssetId);
    const firstJob = await jobRow(first.renderJobId);

    const saved = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      first.clipId,
      { version: 1, startMs: 5000, endMs: 6500, aspect: '1:1', cropMode: 'fit', captions: null },
      meta,
    );
    expect(saved.revisionCreated).toBe(true);
    const requested = await requestClipRender(
      c.app,
      t.owner,
      t.workspaceId,
      first.clipId,
      {},
      meta,
    );
    expect(requested.status).toBe(202);
    expect(requested.body.outputAssetId).not.toBe(first.outputAssetId);
    expect(requested.body.revisionId).toBe(saved.revision.id);
    expect(await run(requested.body.renderJobId)).toBe('succeeded');

    const secondJob = await jobRow(requested.body.renderJobId);
    expect(secondJob.renderKey).not.toBe(firstJob.renderKey);
    const second = await assetRow(requested.body.outputAssetId);
    const geometry = clipGeometry({
      sourceWidth: 1280,
      sourceHeight: 720,
      aspect: '1:1',
      cropMode: 'fit',
    });
    expect(second).toMatchObject({
      status: 'ready',
      width: geometry.outWidth,
      height: geometry.outHeight,
      durationMs: 1500,
    });
    expect(second.objectKey).not.toBe(firstAsset.objectKey);
    expect(await assetRow(first.outputAssetId)).toEqual(firstAsset);
    expect(await jobRow(first.renderJobId)).toEqual(firstJob);

    // The older revision can still be asked for by ID and resolves to its finished render.
    const old = await requestClipRender(
      c.app,
      t.owner,
      t.workspaceId,
      first.clipId,
      { revisionId: first.revisionId },
      meta,
    );
    expect(old.status).toBe(200);
    expect(old.body.outputAssetId).toBe(first.outputAssetId);
    // A revision of another clip is refused.
    const stranger = await createClip(
      c.app,
      t.owner,
      t.workspaceId,
      { sourceAssetId: timecode, startMs: 0, endMs: 1000 },
      meta,
    );
    await expectAppError(
      requestClipRender(
        c.app,
        t.owner,
        t.workspaceId,
        first.clipId,
        { revisionId: stranger.body.revisionId },
        meta,
      ),
      'validation_failed',
    );
  });

  describe('sources that need normalising, through the whole service path', () => {
    const cases = [
      {
        name: 'odd dimensions without audio, original aspect',
        fixture: 'odd-721x1279-3s.mp4',
        source: { width: 721, height: 1279, hasAudio: false },
        range: { startMs: 500, endMs: 2500 },
        edit: { aspect: 'original', cropMode: 'fill' },
      },
      {
        name: 'no audio track, square source padded to 9:16',
        fixture: 'square-720-noaudio-4s.mp4',
        source: { width: 720, height: 720, hasAudio: false },
        range: { startMs: 1000, endMs: 3000 },
        edit: { aspect: '9:16', cropMode: 'fit' },
      },
      {
        name: 'rotation metadata, with burned-in captions',
        fixture: 'rotated-90-5s.mp4',
        source: { width: 720, height: 1280, hasAudio: true },
        range: { startMs: 1000, endMs: 3000 },
        edit: {
          aspect: '1:1',
          cropMode: 'fill',
          captions: [
            { startMs: 1200, endMs: 2000, text: 'First line' },
            { startMs: 2100, endMs: 2900, text: 'Second line {\\an8}' },
          ],
        },
      },
    ] as const;

    for (const k of cases) {
      it(k.name, async () => {
        const sourceId = await upload(k.fixture);
        const source = await assetRow(sourceId);
        // Display dimensions, after rotation.
        expect(source).toMatchObject({ width: k.source.width, height: k.source.height });
        const r = await renderClipOf(c, t, t.owner, sourceId, k.range, { edit: k.edit });
        expect(r.outcome).toBe('succeeded');
        const geometry = clipGeometry({
          sourceWidth: k.source.width,
          sourceHeight: k.source.height,
          aspect: k.edit.aspect,
          cropMode: k.edit.cropMode,
        });
        const clip = await fetchClip(r.outputAssetId);
        expect(clip.asset).toMatchObject({
          status: 'ready',
          origin: 'render',
          width: geometry.outWidth,
          height: geometry.outHeight,
          durationMs: k.range.endMs - k.range.startMs,
          hasAudio: k.source.hasAudio,
          videoCodec: 'h264',
          audioCodec: k.source.hasAudio ? 'aac' : null,
          pixFmt: 'yuv420p',
          rotation: 0,
        });
        expect(clip.asset.width! % 2).toBe(0);
        expect(clip.asset.height! % 2).toBe(0);
        // Exactly the frames of the range on the 30 fps grid.
        expect(await regionLuma(clip.file, 'iw:ih:0:0')).toHaveLength(
          ((k.range.endMs - k.range.startMs) * 30) / 1000,
        );
        expect(await variantRows(r.outputAssetId)).toHaveLength(2);
        expect(await assetRow(sourceId)).toEqual(source);
      });
    }
  });

  it('rights revoked before the render: the job fails, the asset is rejected, nothing is stored', async () => {
    const sourceId = await upload('timecode-30fps.mp4');
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      sourceId,
      { startMs: 0, endMs: 1500 },
      { process: false },
    );
    const output = await assetRow(r.outputAssetId);
    expect(output).toMatchObject({ status: 'validating', origin: 'render' });
    await revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: await grantId(sourceId), reason: 'Consent withdrawn' },
      meta,
    );

    expect(await run(r.renderJobId)).toBe('failed');
    expect(await jobRow(r.renderJobId)).toMatchObject({
      status: 'failed',
      errorCode: 'rights_revoked',
      outputProbe: null,
    });
    expect(await assetRow(r.outputAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'rights_revoked',
      sha256: null,
    });
    expect(await c.worker.storage.head(output.objectKey)).toBeNull();
    for (const key of variantKeys(r.outputAssetId))
      expect(await c.worker.storage.head(key)).toBeNull();
    expect(await variantRows(r.outputAssetId)).toEqual([]);
    expect(await usageRows(r.renderJobId)).toEqual([]);
    expect(await auditActions(r.renderJobId)).toEqual([
      'clip.render_requested',
      'clip.render_failed',
    ]);
    const jobRun = await getJobRun(c.app, t.owner, t.workspaceId, r.requested.body.jobId!);
    expect(jobRun.job).toMatchObject({ status: 'failed', errorCode: 'rights_revoked' });
    // Not retried, and a new request is refused while the rights are gone.
    expect(await run(r.renderJobId)).toBe('skipped');
    await expectAppError(
      requestClipRender(c.app, t.owner, t.workspaceId, r.clipId, {}, meta),
      'rights_missing',
    );
  });

  it('rights revoked during the render: no ready asset, and the stored clip is removed', async () => {
    const sourceId = await upload('timecode-30fps.mp4');
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      sourceId,
      { startMs: 0, endMs: 1000 },
      { process: false },
    );
    const output = await assetRow(r.outputAssetId);
    const grant = await grantId(sourceId);
    // The revoke lands after the first rights check, while the clip is being stored.
    const real = c.worker.storage;
    const revoking = Object.create(real) as ObjectStorage;
    let stored = false;
    revoking.uploadFile = async (input) => {
      const put = await real.uploadFile(input);
      if (input.key === output.objectKey) {
        stored = true;
        await revokeRightsGrant(
          c.app,
          t.owner,
          t.workspaceId,
          { grantId: grant, reason: 'Consent withdrawn' },
          meta,
        );
      }
      return put;
    };
    expect(await run(r.renderJobId, ATTEMPT, { ...c.worker, storage: revoking })).toBe('failed');
    expect(stored).toBe(true);
    expect(await jobRow(r.renderJobId)).toMatchObject({
      status: 'failed',
      errorCode: 'rights_revoked',
    });
    expect(await assetRow(r.outputAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'rights_revoked',
    });
    expect(await real.head(output.objectKey)).toBeNull();
    for (const key of variantKeys(r.outputAssetId)) expect(await real.head(key)).toBeNull();
    expect(await variantRows(r.outputAssetId)).toEqual([]);
  });

  it('rights revoked after the render block the clip: publish, preview and export', async () => {
    const sourceId = await upload('timecode-30fps.mp4');
    const r = await renderClipOf(c, t, t.owner, sourceId, { startMs: 0, endMs: 1000 });
    expect(r.outcome).toBe('succeeded');
    const publishRights = () =>
      inTenant((tx) =>
        evaluateRights(tx, {
          assetIds: [r.outputAssetId],
          provider: 'youtube',
          operation: 'publish',
          at: c.clock.now(),
        }),
      );
    const before = await publishRights();
    expect(before.ok).toBe(true);
    // Reported under the clip's ID, backed by the source's grant.
    expect(before.grants).toEqual([
      { assetId: r.outputAssetId, grantId: await grantId(sourceId), grantVersion: 1 },
    ]);
    const rightsVersionBefore = (await assetRow(r.outputAssetId)).rightsVersion;

    const exported = await exportClip(c.app, t.owner, t.workspaceId, r.clipId, meta);
    expect(exported).toMatchObject({ assetId: r.outputAssetId, revisionId: r.revisionId });
    const download = await fetchAll(exported.url);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(download.bytes.length).toBe(exported.sizeBytes);
    expect(await auditActions(r.clipId)).toContain('clip.exported');
    const viewer = await join('viewer');
    await expectAppError(exportClip(c.app, viewer, t.workspaceId, r.clipId, meta), 'forbidden');

    await revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: await grantId(sourceId), reason: 'Licence ended' },
      meta,
    );
    const after = await publishRights();
    expect(after.ok).toBe(false);
    expect(after.problems).toEqual([{ assetId: r.outputAssetId, reason: 'revoked' }]);
    expect((await assetRow(r.outputAssetId)).rightsVersion).toBeGreaterThan(rightsVersionBefore);
    for (const variant of ['thumbnail', 'proxy', 'original'] as const)
      await expectAppError(
        mediaUrl(c.app, t.owner, t.workspaceId, r.outputAssetId, variant),
        'rights_missing',
      );
    await expectAppError(
      mediaUrl(c.app, t.owner, t.workspaceId, sourceId, 'proxy'),
      'rights_missing',
    );
    await expectAppError(
      exportClip(c.app, t.owner, t.workspaceId, r.clipId, meta),
      'rights_missing',
    );
    // The rendered asset itself is untouched; only its use is blocked.
    expect(await assetRow(r.outputAssetId)).toMatchObject({ status: 'ready' });
  });

  it('a clip needs the edit right on its source, whatever else the grant allows', async () => {
    const sourceId = await upload('timecode-30fps.mp4');
    const r = await renderClipOf(c, t, t.owner, sourceId, { startMs: 0, endMs: 1000 });
    expect(r.outcome).toBe('succeeded');
    await revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: await grantId(sourceId), reason: 'Replaced by a narrower licence' },
      meta,
    );
    // A licence that lets the source be viewed and published as it is, but not edited.
    await inTenant((tx) =>
      tx
        .insertInto('sourceRightsGrants')
        .values({
          id: c.app.ids.next(),
          workspaceId: t.workspaceId,
          assetId: sourceId,
          grantType: 'license',
          grantorName: 'Rights holder',
          canView: true,
          canEdit: false,
          canExport: true,
          canPublish: true,
          canCommercialUse: true,
          validFrom: c.clock.now(),
        })
        .execute(),
    );
    const check = (assetId: string) =>
      inTenant((tx) =>
        evaluateRights(tx, { assetIds: [assetId], operation: 'publish', at: c.clock.now() }),
      );
    expect((await check(sourceId)).ok).toBe(true);
    expect(await check(r.outputAssetId)).toMatchObject({
      ok: false,
      problems: [{ assetId: r.outputAssetId, reason: 'operation_denied' }],
    });
    await expectAppError(
      mediaUrl(c.app, t.owner, t.workspaceId, r.outputAssetId, 'proxy'),
      'rights_missing',
    );
    expect((await mediaUrl(c.app, t.owner, t.workspaceId, sourceId, 'proxy')).url).toMatch(/^http/);
  });

  it('reserves quota for a render and releases it when the render fails', async () => {
    // Room for the source and one reservation of a one-second clip, not two.
    const reservation = clipReservedBytes(1000, 512 * 1024 * 1024);
    const small = makeContexts({
      config: testConfig({
        RELAY_WORKSPACE_STORAGE_QUOTA_BYTES: String(1024 * 1024 + reservation),
      }),
    });
    try {
      const q = await createTenant(small.app);
      const sourceId = (await uploadFixture(small, q, q.owner, 'timecode-30fps.mp4', 'video/mp4'))
        .assetId;
      const rows = () =>
        withTenant(small.app.db, { workspaceId: q.workspaceId }, async (tx) => ({
          jobs: await tx.selectFrom('renderJobs').select(['id', 'status']).execute(),
          rendered: await tx
            .selectFrom('mediaAssets')
            .select(['id', 'status'])
            .where('origin', '=', 'render')
            .execute(),
        }));

      const first = await renderClipOf(
        small,
        q,
        q.owner,
        sourceId,
        { startMs: 0, endMs: 1000 },
        { process: false },
      );
      expect(first.requested.status).toBe(202);
      // While the first output is reserved, a second render does not fit.
      const second = await createClip(
        small.app,
        q.owner,
        q.workspaceId,
        { sourceAssetId: sourceId, startMs: 2000, endMs: 3000 },
        meta,
      );
      const refused = await expectAppError(
        requestClipRender(small.app, q.owner, q.workspaceId, second.body.clipId, {}, meta),
        'quota_exceeded',
      );
      expect(refused.details).toMatchObject({ requestedBytes: reservation });
      expect(await rows()).toEqual({
        jobs: [{ id: first.renderJobId, status: 'queued' }],
        rendered: [{ id: first.outputAssetId, status: 'validating' }],
      });

      // The first render fails for good (no usable scratch space on its last attempt).
      const broken = {
        ...small.worker,
        config: {
          ...small.worker.config,
          media: { ...small.worker.config.media, scratchDir: path.join(scratch, 'missing') },
        },
      };
      expect(
        await processClipRender(
          broken,
          { workspaceId: q.workspaceId, renderJobId: first.renderJobId },
          LAST_ATTEMPT,
        ),
      ).toBe('failed');
      expect(await rows()).toEqual({
        jobs: [{ id: first.renderJobId, status: 'failed' }],
        rendered: [{ id: first.outputAssetId, status: 'rejected' }],
      });
      // Its reservation no longer counts, and the same edit can be requested again.
      const retried = await requestClipRender(
        small.app,
        q.owner,
        q.workspaceId,
        second.body.clipId,
        {},
        meta,
      );
      expect(retried.status).toBe(202);
      const again = await requestClipRender(
        small.app,
        q.owner,
        q.workspaceId,
        first.clipId,
        {},
        meta,
      ).catch((e: unknown) => e);
      // The failed job does not hold the render key; only the quota decides here.
      expect((again as { code?: string }).code).toBe('quota_exceeded');
    } finally {
      await small.close();
    }
  });

  it('fails without a retry when a transient error persists to the last attempt', async () => {
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      timecode,
      { startMs: 9000, endMs: 10000 },
      { process: false },
    );
    const broken = {
      ...c.worker,
      config: {
        ...c.worker.config,
        media: { ...c.worker.config.media, scratchDir: path.join(scratch, 'missing') },
      },
    };
    await expect(run(r.renderJobId, ATTEMPT, broken)).rejects.toThrow();
    expect(await jobRow(r.renderJobId)).toMatchObject({ status: 'running' });
    expect(await run(r.renderJobId, LAST_ATTEMPT, broken)).toBe('failed');
    expect(await jobRow(r.renderJobId)).toMatchObject({
      status: 'failed',
      errorCode: 'processing_failed',
    });
    expect(await assetRow(r.outputAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'processing_failed',
    });
    // A new request for the same edit starts a fresh job and a fresh asset.
    const retry = await requestClipRender(c.app, t.owner, t.workspaceId, r.clipId, {}, meta);
    expect(retry.status).toBe(202);
    expect(retry.body.outputAssetId).not.toBe(r.outputAssetId);
    expect(await run(retry.body.renderJobId)).toBe('succeeded');
  });

  it('marks the clip of a sample source as a sample', async () => {
    // Sample media is written by the seed; the app role may insert such a row directly.
    const template = await assetRow(timecode);
    const sampleId = c.app.ids.next();
    await inTenant(async (tx) => {
      await tx
        .insertInto('mediaAssets')
        .values({
          id: sampleId,
          workspaceId: t.workspaceId,
          pageId: t.pageId,
          kind: 'video',
          status: 'ready',
          originalFilename: 'sample.mp4',
          declaredMime: 'video/mp4',
          sizeBytes: template.sizeBytes,
          sha256: template.sha256,
          objectKey: `ws/${t.workspaceId}/assets/${sampleId}/v1/original.mp4`,
          width: template.width,
          height: template.height,
          durationMs: template.durationMs,
          hasAudio: true,
          isSample: true,
          validatedAt: c.clock.now(),
          createdBy: t.owner.userId,
        })
        .execute();
      await tx
        .insertInto('sourceRightsGrants')
        .values({
          id: c.app.ids.next(),
          workspaceId: t.workspaceId,
          assetId: sampleId,
          grantType: 'first_party_declaration',
          grantorUserId: t.owner.userId,
          canView: true,
          canEdit: true,
          canExport: true,
          canPublish: true,
          canCommercialUse: false,
          validFrom: c.clock.now(),
        })
        .execute();
    });
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      sampleId,
      { startMs: 0, endMs: 1000 },
      { process: false },
    );
    expect(await assetRow(r.outputAssetId)).toMatchObject({
      isSample: true,
      status: 'validating',
      origin: 'render',
      originalFilename: 'Clip of sample.mp4.mp4',
    });
    // Its object does not exist, so the worker fails the render instead of producing anything.
    expect(await run(r.renderJobId, LAST_ATTEMPT)).toBe('failed');
  });

  it('hides clips from other tenants and from roles that may not render', async () => {
    const r = await renderClipOf(
      c,
      t,
      t.owner,
      timecode,
      { startMs: 10000, endMs: 11000 },
      { process: false },
    );
    const other = await createTenant(c.app);
    await expectAppError(
      requestClipRender(c.app, other.owner, other.workspaceId, r.clipId, {}, meta),
      'not_found',
    );
    await expectAppError(
      requestClipRender(c.app, other.owner, t.workspaceId, r.clipId, {}, meta),
      'not_found',
    );
    await expectAppError(
      exportClip(c.app, other.owner, other.workspaceId, r.clipId, meta),
      'not_found',
    );
    await expectAppError(
      getJobRun(c.app, other.owner, other.workspaceId, r.requested.body.jobId!),
      'not_found',
    );
    // The worker task only acts inside the workspace named in its payload.
    expect(
      await processClipRender(
        c.worker,
        { workspaceId: other.workspaceId, renderJobId: r.renderJobId },
        ATTEMPT,
      ),
    ).toBe('skipped');
    expect(await jobRow(r.renderJobId)).toMatchObject({ status: 'queued' });

    const viewer = await join('viewer');
    await expectAppError(
      requestClipRender(c.app, viewer, t.workspaceId, r.clipId, {}, meta),
      'forbidden',
    );
    const editor = await join('editor');
    const asEditor = await requestClipRender(c.app, editor, t.workspaceId, r.clipId, {}, meta);
    expect(asEditor.status).toBe(200);
    expect(asEditor.body.renderJobId).toBe(r.renderJobId);
    // Exporting before the render has finished is refused with a specific error.
    await expectAppError(
      exportClip(c.app, t.owner, t.workspaceId, r.clipId, meta),
      'media_not_ready',
    );
    expect(await run(r.renderJobId)).toBe('succeeded');
  });
});
