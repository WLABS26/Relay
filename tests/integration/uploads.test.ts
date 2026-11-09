import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { abortUpload, completeUpload, getAsset, mediaUrl, startUpload } from '@relay/services';
import {
  createTenant,
  expectAppError,
  fetchAll,
  fixturePath,
  makeContexts,
  meta,
  testConfig,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

const declaration = { confirmed: true as const, statementVersion: 'first-party-v1' };

describe('uploads and media validation (M1 gate)', () => {
  let c: Contexts;
  let t: Tenant;

  beforeAll(async () => {
    // A tiny single-PUT limit forces multipart for the larger fixtures.
    c = makeContexts({
      config: testConfig({
        RELAY_SINGLE_UPLOAD_MAX_BYTES: String(1024 * 1024),
        RELAY_MULTIPART_PART_BYTES: String(5 * 1024 * 1024),
      }),
    });
    t = await createTenant(c.app);
  });
  afterAll(async () => c.close());

  it.each([
    [
      'vertical-1080x1920-8s.mp4',
      'video/mp4',
      { width: 1080, height: 1920, durationMs: 8000, hasAudio: true },
    ],
    [
      'square-720-noaudio-4s.mp4',
      'video/mp4',
      { width: 720, height: 720, durationMs: 4000, hasAudio: false },
    ],
    ['rotated-90-5s.mp4', 'video/mp4', { width: 720, height: 1280, rotation: 90 }],
    ['odd-721x1279-3s.mp4', 'video/mp4', { width: 721, height: 1279 }],
    ['portrait-1080x1350.jpg', 'image/jpeg', { width: 1080, height: 1350 }],
    ['square-1080.png', 'image/png', { width: 1080, height: 1080 }],
  ])('accepts %s and records normalised metadata and derivatives', async (name, mime, expected) => {
    const up = await uploadFixture(c, t, t.owner, name, mime);
    expect(up.outcome).toBe('ready');
    const { asset, variants, grants } = await getAsset(c.app, t.owner, t.workspaceId, up.assetId);
    expect(asset).toMatchObject({ status: 'ready', ...expected });
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(variants.map((v) => v.kind).sort()).toEqual(
      mime.startsWith('video') ? ['proxy', 'thumbnail'] : ['thumbnail'],
    );
    expect(grants[0]).toMatchObject({
      grantType: 'first_party_declaration',
      statementVersion: 'first-party-v1',
      canPublish: true,
    });
    const thumb = await mediaUrl(c.app, t.owner, t.workspaceId, up.assetId, 'thumbnail');
    const res = await fetchAll(thumb.url);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect([...res.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // a real JPEG, not a label
  });

  it('used multipart for a file above the single-PUT limit', async () => {
    const up = await uploadFixture(c, t, t.owner, 'vertical-1080x1920-8s.mp4', 'video/mp4');
    expect(up.strategy).toBe('multipart');
    expect(up.outcome).toBe('ready');
  });

  it.each([
    ['malformed.mp4', 'video/mp4', 'malformed_media'],
    ['truncated.mp4', 'video/mp4', 'malformed_media'],
    ['encrypted-cenc.mp4', 'video/mp4', 'encrypted_media'],
    ['mislabeled-video.png', 'image/png', 'mime_mismatch'],
  ])('rejects %s as %s and deletes the stored bytes', async (name, mime, code) => {
    const up = await uploadFixture(c, t, t.owner, name, mime);
    expect(up.outcome).toBe('rejected');
    const { asset } = await getAsset(c.app, t.owner, t.workspaceId, up.assetId);
    expect(asset).toMatchObject({ status: 'rejected', rejectionCode: code });
    const key = await withTenant(c.worker.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .selectFrom('mediaAssets')
        .select('objectKey')
        .where('id', '=', up.assetId)
        .executeTakeFirstOrThrow(),
    );
    expect(await c.app.storage.head(key.objectKey)).toBeNull();
    await expectAppError(
      mediaUrl(c.app, t.owner, t.workspaceId, up.assetId, 'original'),
      'media_not_ready',
    );
  });

  it('refuses unsupported types, extension mismatches and oversized declarations before issuing URLs', async () => {
    await expectAppError(
      startUpload(
        c.app,
        t.owner,
        t.workspaceId,
        { pageId: t.pageId, filename: 'a.gif', mimeType: 'image/gif', sizeBytes: 10, declaration },
        meta,
      ),
      'unsupported_media_type',
    );
    await expectAppError(
      startUpload(
        c.app,
        t.owner,
        t.workspaceId,
        { pageId: t.pageId, filename: 'a.png', mimeType: 'video/mp4', sizeBytes: 10, declaration },
        meta,
      ),
      'unsupported_media_type',
    );
    await expectAppError(
      startUpload(
        c.app,
        t.owner,
        t.workspaceId,
        {
          pageId: t.pageId,
          filename: 'a.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 31 * 1024 ** 2,
          declaration,
        },
        meta,
      ),
      'payload_too_large',
    );
    // The ownership declaration is mandatory.
    await expect(
      startUpload(
        c.app,
        t.owner,
        t.workspaceId,
        { pageId: t.pageId, filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 10 } as never,
        meta,
      ),
    ).rejects.toThrow();
  });

  it('enforces the workspace storage quota before any upload URL is issued', async () => {
    const small = makeContexts({
      config: testConfig({ RELAY_WORKSPACE_STORAGE_QUOTA_BYTES: String(200 * 1024) }),
    });
    try {
      const q = await createTenant(small.app);
      await uploadFixture(small, q, q.owner, 'portrait-1080x1350.jpg', 'image/jpeg'); // ~94 KB + thumbnail
      await expectAppError(
        startUpload(
          small.app,
          q.owner,
          q.workspaceId,
          {
            pageId: q.pageId,
            filename: 'b.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 150 * 1024,
            declaration,
          },
          meta,
        ),
        'quota_exceeded',
      );
    } finally {
      await small.close();
    }
  });

  it('detects a size mismatch at completion and cleans up', async () => {
    const bytes = await readFile(fixturePath('square-1080.png'));
    const start = await startUpload(
      c.app,
      t.owner,
      t.workspaceId,
      {
        pageId: t.pageId,
        filename: 'x.png',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        declaration,
      },
      meta,
    );
    // The presigned URL binds content-length: a shorter body is refused by storage.
    const short = await fetchAll(start.body.single!.url, {
      method: 'PUT',
      body: bytes.subarray(0, 100),
      headers: start.body.single!.headers,
    });
    expect(short.status).toBeGreaterThanOrEqual(400);
    await expectAppError(
      completeUpload(c.app, t.owner, t.workspaceId, start.body.uploadId, {}, meta),
      'upload_incomplete',
    );
  });

  it('rejects a late PUT that tries to replace an uploaded object', async () => {
    const bytes = await readFile(fixturePath('portrait-1080x1350.jpg'));
    const start = await startUpload(
      c.app,
      t.owner,
      t.workspaceId,
      {
        pageId: t.pageId,
        filename: 'y.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: bytes.length,
        declaration,
      },
      meta,
    );
    const url = start.body.single!.url;
    expect(
      (await fetchAll(url, { method: 'PUT', body: bytes, headers: start.body.single!.headers }))
        .status,
    ).toBe(200);
    const replay = await fetchAll(url, {
      method: 'PUT',
      body: Buffer.alloc(bytes.length, 1),
      headers: start.body.single!.headers,
    });
    expect(replay.status).toBe(412); // If-None-Match: * protects validated bytes
    await completeUpload(c.app, t.owner, t.workspaceId, start.body.uploadId, {}, meta);
  });

  it('aborts an upload, releases the reservation and refuses further completion', async () => {
    const start = await startUpload(
      c.app,
      t.owner,
      t.workspaceId,
      { pageId: t.pageId, filename: 'z.jpg', mimeType: 'image/jpeg', sizeBytes: 5000, declaration },
      meta,
    );
    await abortUpload(c.app, t.owner, t.workspaceId, start.body.uploadId, meta);
    await expectAppError(
      completeUpload(c.app, t.owner, t.workspaceId, start.body.uploadId, {}, meta),
      'upload_state_invalid',
    );
    const s = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .selectFrom('uploadSessions')
        .select(['status', 'reservationReleasedAt'])
        .where('id', '=', start.body.uploadId)
        .executeTakeFirstOrThrow(),
    );
    expect(s.status).toBe('aborted');
    expect(s.reservationReleasedAt).toBeInstanceOf(Date);
  });
});
