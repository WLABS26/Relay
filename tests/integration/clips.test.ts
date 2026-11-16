import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, withTenant } from '@relay/db';
import { clipGeometry, RANKER_VERSION } from '@relay/domain';
import { clipEditHash } from '@relay/domain/server';
import { ANALYZER_VERSION } from '@relay/media';
import {
  acceptInvitation,
  createPage,
  getAsset,
  inviteMember,
  revokeRightsGrant,
  type AuthenticatedUser,
} from '@relay/services';
import {
  createClip,
  getClip,
  importCaptions,
  listClips,
  updateClip,
} from '../../packages/services/src/clips';
import {
  createTenant,
  createUser,
  expectAppError,
  makeContexts,
  meta,
  unique,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

const SOURCE_FIXTURE = 'landscape-1280x720-6s.mp4';
const SOURCE_DURATION_MS = 6000;

describe('clip projects and revisions (M2)', () => {
  let c: Contexts;
  let t: Tenant;
  let sourceId: string;
  let sourceBefore: unknown;

  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(c.app.db, { workspaceId: t.workspaceId }, fn);

  const assetRow = (assetId: string) =>
    inTenant((tx) =>
      tx.selectFrom('mediaAssets').selectAll().where('id', '=', assetId).executeTakeFirstOrThrow(),
    );
  /** Revision rows with the stored captions as text, so "unchanged" means byte for byte. */
  const revisionRows = (clipId: string) =>
    inTenant((tx) =>
      tx
        .selectFrom('clipRevisions')
        .selectAll()
        .select(sql<string | null>`captions::text`.as('captionsText'))
        .where('clipId', '=', clipId)
        .orderBy('revisionNumber', 'asc')
        .execute(),
    );
  const candidateRow = (candidateId: string) =>
    inTenant((tx) =>
      tx
        .selectFrom('clipCandidates')
        .selectAll()
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow(),
    );
  const auditActions = async (clipId: string) =>
    (
      await inTenant((tx) =>
        tx
          .selectFrom('auditEvents')
          .select(['action', 'id'])
          .where('entityId', '=', clipId)
          .orderBy('id', 'asc')
          .execute(),
      )
    ).map((e) => e.action);

  /** A finished analysis with one suggestion, written the way the app and the worker would. */
  async function addCandidate(
    assetId: string,
    range: { startMs: number; endMs: number },
    assetVersion = 1,
  ): Promise<string> {
    const analysisId = c.app.ids.next();
    await inTenant((tx) =>
      tx
        .insertInto('mediaAnalyses')
        .values({
          id: analysisId,
          workspaceId: t.workspaceId,
          assetId,
          assetVersion,
          status: 'succeeded',
          analyzerVersion: ANALYZER_VERSION,
          // One live analysis per asset and version pair; each test suggestion gets its own.
          rankerVersion: unique(RANKER_VERSION).slice(0, 60),
          requestedBy: t.owner.userId,
        })
        .execute(),
    );
    const candidateId = c.worker.ids.next();
    await withTenant(c.worker.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .insertInto('clipCandidates')
        .values({
          id: candidateId,
          workspaceId: t.workspaceId,
          analysisId,
          assetId,
          rank: 1,
          startMs: range.startMs,
          endMs: range.endMs,
          score: '0.9',
          confidence: '0.8',
          reason: 'Loud passage after a pause',
          rankerVersion: RANKER_VERSION,
        })
        .execute(),
    );
    return candidateId;
  }

  const manualClip = async (range = { startMs: 1000, endMs: 4000 }, user = t.owner) =>
    (await createClip(c.app, user, t.workspaceId, { sourceAssetId: sourceId, ...range }, meta))
      .body;

  const edit = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    startMs: 1000,
    endMs: 4000,
    aspect: '9:16',
    cropMode: 'fill',
    captions: null,
    ...overrides,
  });

  async function join(
    role: 'editor' | 'viewer',
    pages: { allPages: boolean; pageIds: string[] },
  ): Promise<AuthenticatedUser> {
    const user = await createUser(c.app, { name: `${role} user` });
    const invite = await inviteMember(
      c.app,
      t.owner,
      t.workspaceId,
      { email: user.email, role, ...pages },
      meta,
    );
    await acceptInvitation(c.app, user, { token: invite.token }, meta);
    return user;
  }

  beforeAll(async () => {
    c = makeContexts();
    t = await createTenant(c.app);
    sourceId = (await uploadFixture(c, t, t.owner, SOURCE_FIXTURE, 'video/mp4')).assetId;
    sourceBefore = await assetRow(sourceId);
    expect(sourceBefore).toMatchObject({ status: 'ready', durationMs: SOURCE_DURATION_MS });
  });
  afterAll(async () => {
    // Every test above edited clips of this source; none of them may have written it.
    expect(await assetRow(sourceId)).toEqual(sourceBefore);
    await c.close();
  });

  it('creates a clip from a suggested candidate and marks the candidate accepted', async () => {
    const candidateId = await addCandidate(sourceId, { startMs: 500, endMs: 3500 });
    const created = await createClip(
      c.app,
      t.owner,
      t.workspaceId,
      { sourceAssetId: sourceId, candidateId },
      meta,
    );
    expect(created.status).toBe(201);
    expect(created.replayed).toBe(false);
    expect(created.body.version).toBe(1);

    const detail = await getClip(c.app, t.owner, t.workspaceId, created.body.clipId);
    expect(detail.clip).toMatchObject({
      id: created.body.clipId,
      pageId: t.pageId,
      sourceAssetId: sourceId,
      sourceAssetVersion: 1,
      candidateId,
      title: `Clip of ${SOURCE_FIXTURE}`,
      currentRevisionId: created.body.revisionId,
      version: 1,
      createdBy: t.owner.userId,
    });
    expect(detail.revision).toMatchObject({
      id: created.body.revisionId,
      revisionNumber: 1,
      startMs: 500,
      endMs: 3500,
      aspect: '9:16',
      cropMode: 'fill',
      captions: null,
      captionStyle: 'default',
      editHash: clipEditHash({
        startMs: 500,
        endMs: 3500,
        aspect: '9:16',
        cropMode: 'fill',
        captions: null,
        captionStyle: 'default',
      }),
    });
    expect(detail.source).toMatchObject({
      id: sourceId,
      status: 'ready',
      width: 1280,
      height: 720,
      durationMs: SOURCE_DURATION_MS,
    });
    expect(detail.latestRender).toBeNull();
    expect(detail.geometry).toEqual(
      clipGeometry({ sourceWidth: 1280, sourceHeight: 720, aspect: '9:16', cropMode: 'fill' }),
    );

    expect(await candidateRow(candidateId)).toMatchObject({
      feedback: 'accepted',
      feedbackBy: t.owner.userId,
    });
    expect(await auditActions(created.body.clipId)).toEqual(['clip.created']);
  });

  it('refuses a candidate that belongs to another asset, or a candidate with a range', async () => {
    const other = (await uploadFixture(c, t, t.owner, 'square-720-noaudio-4s.mp4', 'video/mp4'))
      .assetId;
    const foreign = await addCandidate(other, { startMs: 0, endMs: 2000 });
    const error = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, candidateId: foreign },
        meta,
      ),
      'validation_failed',
    );
    expect(error.fieldErrors).toHaveProperty('candidateId');
    expect((await candidateRow(foreign)).feedback).toBeNull();

    // A suggestion from an analysis of other bytes of the same asset is on another timeline.
    const stale = await addCandidate(sourceId, { startMs: 0, endMs: 2000 }, 2);
    const staleError = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, candidateId: stale },
        meta,
      ),
      'validation_failed',
    );
    expect(staleError.fieldErrors).toHaveProperty('candidateId');
    expect((await candidateRow(stale)).feedback).toBeNull();

    await expect(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, candidateId: foreign, startMs: 0, endMs: 2000 },
        meta,
      ),
    ).rejects.toThrow();
  });

  it('creates a clip from a manual range and replays an idempotent request', async () => {
    const key = unique('clip-create');
    const input = { sourceAssetId: sourceId, startMs: 1000, endMs: 4000, title: 'Opening' };
    const first = await createClip(c.app, t.owner, t.workspaceId, input, {
      ...meta,
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.replayed).toBe(false);

    const replay = await createClip(c.app, t.owner, t.workspaceId, input, {
      ...meta,
      idempotencyKey: key,
    });
    // The route answers 200 for a replay; the service reports it and returns the stored body.
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);

    const { clips } = await listClips(c.app, t.owner, t.workspaceId, { sourceAssetId: sourceId });
    const opening = clips.filter((clip) => clip.title === 'Opening');
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({
      id: first.body.clipId,
      currentRevisionId: first.body.revisionId,
      revisionNumber: 1,
      startMs: 1000,
      endMs: 4000,
      candidateId: null,
      hasCaptions: false,
    });
    expect(await revisionRows(first.body.clipId)).toHaveLength(1);

    await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { ...input, endMs: 4500 },
        { ...meta, idempotencyKey: key },
      ),
      'idempotency_key_reused',
    );
  });

  it('saves an edit as revision 2 and leaves revision 1 byte-identical', async () => {
    const candidateId = await addCandidate(sourceId, { startMs: 1000, endMs: 4000 });
    const created = (
      await createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, candidateId },
        meta,
      )
    ).body;
    const [before] = await revisionRows(created.clipId);

    const captions = [
      { startMs: 1500, endMs: 2500, text: 'First line\nsecond line' },
      { startMs: 2500, endMs: 3500, text: "{\\an8} 'quoted' [in]" },
    ];
    const saved = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      created.clipId,
      edit({
        startMs: 1200,
        endMs: 3800,
        aspect: '1:1',
        cropMode: 'fit',
        captions,
        title: 'Renamed',
      }),
      meta,
    );
    expect(saved.revisionCreated).toBe(true);
    expect(saved.clip).toMatchObject({
      version: 2,
      title: 'Renamed',
      currentRevisionId: saved.revision.id,
    });
    expect(saved.revision).toMatchObject({
      revisionNumber: 2,
      startMs: 1200,
      endMs: 3800,
      aspect: '1:1',
      cropMode: 'fit',
      captions,
      editHash: clipEditHash({
        startMs: 1200,
        endMs: 3800,
        aspect: '1:1',
        cropMode: 'fit',
        captions,
        captionStyle: 'default',
      }),
    });
    expect(saved.revision.id).not.toBe(created.revisionId);

    const rows = await revisionRows(created.clipId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before);
    expect(rows[1]).toMatchObject({ id: saved.revision.id, revisionNumber: 2 });

    const detail = await getClip(c.app, t.owner, t.workspaceId, created.clipId);
    expect(detail.revision).toEqual(saved.revision);
    expect(detail.geometry).toEqual(
      clipGeometry({ sourceWidth: 1280, sourceHeight: 720, aspect: '1:1', cropMode: 'fit' }),
    );
    // The range no longer matches the suggestion it started from.
    expect((await candidateRow(candidateId)).feedback).toBe('trim_adjusted');
    expect(await auditActions(created.clipId)).toEqual(['clip.created', 'clip.updated']);
    const { clips } = await listClips(c.app, t.owner, t.workspaceId, { pageId: t.pageId });
    expect(clips.find((clip) => clip.id === created.clipId)).toMatchObject({
      revisionNumber: 2,
      hasCaptions: true,
      version: 2,
    });
  });

  it('keeps the candidate verdict when only the framing changes', async () => {
    const candidateId = await addCandidate(sourceId, { startMs: 1000, endMs: 4000 });
    const created = (
      await createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, candidateId },
        meta,
      )
    ).body;
    await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      created.clipId,
      edit({ aspect: 'original' }),
      meta,
    );
    expect((await candidateRow(candidateId)).feedback).toBe('accepted');
  });

  it('rejects a save made against a stale version', async () => {
    const created = await manualClip();
    await updateClip(c.app, t.owner, t.workspaceId, created.clipId, edit({ endMs: 4200 }), meta);
    await expectAppError(
      updateClip(c.app, t.owner, t.workspaceId, created.clipId, edit({ endMs: 4400 }), meta),
      'version_conflict',
    );
    expect(await revisionRows(created.clipId)).toHaveLength(2);
    const detail = await getClip(c.app, t.owner, t.workspaceId, created.clipId);
    expect(detail.clip.version).toBe(2);
    expect(detail.revision.endMs).toBe(4200);
  });

  it('reports a range past the end of the source on the endMs field', async () => {
    const onCreate = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, startMs: 3000, endMs: SOURCE_DURATION_MS + 1 },
        meta,
      ),
      'validation_failed',
    );
    expect(onCreate.fieldErrors?.endMs).toEqual(['The end is past the end of the source']);

    // endMs is exclusive, so a range may end exactly at the source duration; startMs is
    // inclusive, so it may not begin there.
    const atEnd = await manualClip({ startMs: 5000, endMs: SOURCE_DURATION_MS });
    expect((await revisionRows(atEnd.clipId))[0]).toMatchObject({
      startMs: 5000,
      endMs: SOURCE_DURATION_MS,
    });
    const fromZero = await manualClip({ startMs: 0, endMs: 1000 });
    expect((await revisionRows(fromZero.clipId))[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: sourceId, startMs: SOURCE_DURATION_MS - 999, endMs: SOURCE_DURATION_MS },
        meta,
      ),
      'validation_failed',
    );

    const created = await manualClip();
    const onUpdate = await expectAppError(
      updateClip(
        c.app,
        t.owner,
        t.workspaceId,
        created.clipId,
        edit({ endMs: SOURCE_DURATION_MS + 500 }),
        meta,
      ),
      'validation_failed',
    );
    expect(onUpdate.fieldErrors?.endMs).toEqual(['The end is past the end of the source']);

    const tooShort = await expectAppError(
      updateClip(c.app, t.owner, t.workspaceId, created.clipId, edit({ endMs: 1500 }), meta),
      'validation_failed',
    );
    expect(tooShort.fieldErrors).toHaveProperty('endMs');
    expect(await revisionRows(created.clipId)).toHaveLength(1);
  });

  it('rejects an overlapping cue and names its index', async () => {
    const created = await manualClip();
    const error = await expectAppError(
      updateClip(
        c.app,
        t.owner,
        t.workspaceId,
        created.clipId,
        edit({
          captions: [
            { startMs: 1000, endMs: 2000, text: 'One' },
            { startMs: 1800, endMs: 2600, text: 'Two' },
            { startMs: 2600, endMs: 3200, text: 'Three' },
          ],
        }),
        meta,
      ),
      'validation_failed',
    );
    expect(error.fieldErrors).toEqual({ 'captions.1.startMs': ['Overlaps the previous cue'] });

    const invisible = await expectAppError(
      updateClip(
        c.app,
        t.owner,
        t.workspaceId,
        created.clipId,
        edit({ captions: [{ startMs: 1000, endMs: 2000, text: 'right\u{202E}to left' }] }),
        meta,
      ),
      'validation_failed',
    );
    expect(invisible.fieldErrors).toHaveProperty(['captions.0.text']);
    expect(await revisionRows(created.clipId)).toHaveLength(1);
  });

  it('refuses captions the revision row could not hold', async () => {
    const created = await manualClip();
    const line = '\u{6F22}'.repeat(42);
    const captions = Array.from({ length: 500 }, (_, i) => ({
      // Half-second cues, so the clip edges at 1 s and 4 s fall between cues.
      startMs: i * 500,
      endMs: (i + 1) * 500,
      text: `${line}\n${line}`,
    }));
    const error = await expectAppError(
      updateClip(c.app, t.owner, t.workspaceId, created.clipId, edit({ captions }), meta),
      'payload_too_large',
    );
    expect(error.fieldErrors).toHaveProperty('captions');
    expect(await revisionRows(created.clipId)).toHaveLength(1);
  });

  it('writes no revision for an identical edit', async () => {
    const created = await manualClip();
    const captions = [{ startMs: 1000, endMs: 2000, text: 'Hello' }];
    const saved = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      created.clipId,
      edit({ captions }),
      meta,
    );
    expect(saved.clip.version).toBe(2);

    const again = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      created.clipId,
      edit({ version: 2, captions }),
      meta,
    );
    expect(again.revisionCreated).toBe(false);
    expect(again.revision).toEqual(saved.revision);
    expect(again.clip).toEqual(saved.clip);
    expect(await revisionRows(created.clipId)).toHaveLength(2);
    expect(await auditActions(created.clipId)).toEqual(['clip.created', 'clip.updated']);

    // An empty caption list renders like no captions, so the first revision is not repeated.
    const fresh = await manualClip();
    const noop = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      fresh.clipId,
      edit({ captions: [] }),
      meta,
    );
    expect(noop.revisionCreated).toBe(false);
    expect(noop.clip.version).toBe(1);
    expect(await revisionRows(fresh.clipId)).toHaveLength(1);

    // A new title alone is saved on the project without a new revision.
    const renamed = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      fresh.clipId,
      edit({ title: 'Only the name' }),
      meta,
    );
    expect(renamed.revisionCreated).toBe(false);
    expect(renamed.clip).toMatchObject({ title: 'Only the name', version: 2 });
    expect(renamed.revision.id).toBe(fresh.revisionId);
    expect(await revisionRows(fresh.clipId)).toHaveLength(1);
  });

  it('imports SRT and WebVTT cues for the editor without saving them', async () => {
    const created = await manualClip({ startMs: 1000, endMs: 5000 });
    const srt = [
      '1',
      '00:00:00,500 --> 00:00:01,500',
      '<i>Hello</i> there',
      '',
      '2',
      '00:00:02,000 --> 00:00:03,000',
      '{\\an8}Second cue',
      '',
    ].join('\n');
    const relative = await importCaptions(c.app, t.owner, t.workspaceId, created.clipId, {
      format: 'srt',
      text: srt,
    });
    // Times in the file count from the clip start by default; cues live on the source timeline.
    expect(relative.cues).toEqual([
      { startMs: 1500, endMs: 2500, text: 'Hello there' },
      { startMs: 3000, endMs: 4000, text: 'Second cue' },
    ]);

    const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nOn the source timeline\n';
    const absolute = await importCaptions(c.app, t.owner, t.workspaceId, created.clipId, {
      format: 'vtt',
      text: vtt,
      relativeTo: 'source',
    });
    expect(absolute.cues).toEqual([{ startMs: 2000, endMs: 3000, text: 'On the source timeline' }]);

    const overlapping = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'One',
      '',
      '2',
      '00:00:01,000 --> 00:00:03,000',
      'Two',
      '',
    ].join('\n');
    const error = await expectAppError(
      importCaptions(c.app, t.owner, t.workspaceId, created.clipId, {
        format: 'srt',
        text: overlapping,
      }),
      'validation_failed',
    );
    expect(error.fieldErrors).toHaveProperty(['captions.1.startMs']);
    await expectAppError(
      importCaptions(c.app, t.owner, t.workspaceId, created.clipId, {
        format: 'vtt',
        text: srt,
      }),
      'validation_failed',
    );

    const detail = await getClip(c.app, t.owner, t.workspaceId, created.clipId);
    expect(detail.clip.version).toBe(1);
    expect(detail.revision.captions).toBeNull();
    expect(await revisionRows(created.clipId)).toHaveLength(1);

    // What the import returned can be saved as is.
    const saved = await updateClip(
      c.app,
      t.owner,
      t.workspaceId,
      created.clipId,
      edit({ endMs: 5000, captions: relative.cues }),
      meta,
    );
    expect(saved.revision.captions).toEqual(relative.cues);
  });

  it('refuses to clip, or keep editing, a source without an edit grant', async () => {
    const assetId = (await uploadFixture(c, t, t.owner, 'vertical-1080x1920-8s.mp4', 'video/mp4'))
      .assetId;
    const created = (
      await createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: assetId, startMs: 0, endMs: 3000 },
        meta,
      )
    ).body;
    const { grants } = await getAsset(c.app, t.owner, t.workspaceId, assetId);
    await revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: grants[0]!.id, reason: 'Licence withdrawn' },
      meta,
    );

    const error = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: assetId, startMs: 0, endMs: 3000 },
        meta,
      ),
      'rights_missing',
    );
    expect(error.details).toEqual({ problems: [{ assetId, reason: 'revoked' }] });
    await expectAppError(
      updateClip(
        c.app,
        t.owner,
        t.workspaceId,
        created.clipId,
        edit({ startMs: 0, endMs: 2000 }),
        meta,
      ),
      'rights_missing',
    );
    expect(await revisionRows(created.clipId)).toHaveLength(1);
    // The project is still readable, so the editor can explain what happened.
    expect((await getClip(c.app, t.owner, t.workspaceId, created.clipId)).clip.id).toBe(
      created.clipId,
    );

    // A grant that never allowed editing is refused as well.
    const viewOnly = (await uploadFixture(c, t, t.owner, 'square-720-noaudio-4s.mp4', 'video/mp4'))
      .assetId;
    await withTenant(c.worker.db, { workspaceId: t.workspaceId }, async (tx) => {
      const before = await tx
        .selectFrom('sourceRightsGrants')
        .select('canEdit')
        .where('assetId', '=', viewOnly)
        .execute();
      expect(before).toEqual([{ canEdit: true }]);
    });
    const viewGrants = (await getAsset(c.app, t.owner, t.workspaceId, viewOnly)).grants;
    await revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: viewGrants[0]!.id, reason: 'Replaced by a view-only licence' },
      meta,
    );
    await inTenant((tx) =>
      tx
        .insertInto('sourceRightsGrants')
        .values({
          id: c.app.ids.next(),
          workspaceId: t.workspaceId,
          assetId: viewOnly,
          grantType: 'first_party_declaration',
          grantorUserId: t.owner.userId,
          statementVersion: 'first-party-v1',
          statement: 'View only',
          canView: true,
          canEdit: false,
          canExport: false,
          canPublish: false,
          canCommercialUse: false,
          validFrom: new Date(Date.now() - 60_000),
        })
        .execute(),
    );
    const denied = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: viewOnly, startMs: 0, endMs: 2000 },
        meta,
      ),
      'rights_missing',
    );
    expect(denied.message).toBe('The recorded rights do not allow editing this media.');
  });

  it('refuses a clip of a rendered asset, an image, or media that is not ready', async () => {
    // A derived asset as a finished render leaves it, with an edit grant of its own so that
    // only its origin can be the reason for the refusal.
    const renderedId = c.app.ids.next();
    await inTenant(async (tx) => {
      await tx
        .insertInto('mediaAssets')
        .values({
          id: renderedId,
          workspaceId: t.workspaceId,
          pageId: t.pageId,
          kind: 'video',
          status: 'ready',
          origin: 'render',
          originalFilename: 'rendered-clip.mp4',
          declaredMime: 'video/mp4',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          objectKey: `ws/${t.workspaceId}/assets/${renderedId}/v1/original.mp4`,
          width: 1080,
          height: 1920,
          durationMs: 5000,
          hasAudio: true,
          validatedAt: new Date(),
          createdBy: t.owner.userId,
        })
        .execute();
      await tx
        .insertInto('sourceRightsGrants')
        .values({
          id: c.app.ids.next(),
          workspaceId: t.workspaceId,
          assetId: renderedId,
          grantType: 'first_party_declaration',
          grantorUserId: t.owner.userId,
          statementVersion: 'first-party-v1',
          statement: 'Test grant',
          canView: true,
          canEdit: true,
          canExport: true,
          canPublish: true,
          canCommercialUse: false,
          validFrom: new Date(Date.now() - 60_000),
        })
        .execute();
    });
    const rendered = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: renderedId, startMs: 0, endMs: 3000 },
        meta,
      ),
      'validation_failed',
    );
    expect(rendered.fieldErrors?.sourceAssetId).toEqual([
      'Choose an uploaded video, not a rendered clip',
    ]);

    const image = (await uploadFixture(c, t, t.owner, 'square-1080.png', 'image/png')).assetId;
    const notVideo = await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: image, startMs: 0, endMs: 3000 },
        meta,
      ),
      'validation_failed',
    );
    expect(notVideo.fieldErrors).toHaveProperty('sourceAssetId');

    const pending = (
      await uploadFixture(c, t, t.owner, SOURCE_FIXTURE, 'video/mp4', { process: false })
    ).assetId;
    await expectAppError(
      createClip(
        c.app,
        t.owner,
        t.workspaceId,
        { sourceAssetId: pending, startMs: 0, endMs: 3000 },
        meta,
      ),
      'media_not_ready',
    );
    const { clips } = await listClips(c.app, t.owner, t.workspaceId, {});
    expect(clips.some((clip) => [renderedId, image, pending].includes(clip.sourceAssetId))).toBe(
      false,
    );
  });

  it('answers not_found to a page-restricted member and to a foreign tenant', async () => {
    const created = await manualClip();
    const otherPage = await createPage(
      c.app,
      t.owner,
      t.workspaceId,
      { name: 'Other page', timezone: 'Europe/Berlin' },
      meta,
    );
    const restricted = await join('editor', { allPages: false, pageIds: [otherPage.id] });
    const foreign = await createTenant(c.app);
    const srt = { format: 'srt', text: '1\n00:00:00,000 --> 00:00:01,000\nHi\n' };

    for (const [user, workspaceId] of [
      [restricted, t.workspaceId],
      // Another tenant's owner: against our workspace, and with our IDs inside their own.
      [foreign.owner, t.workspaceId],
      [foreign.owner, foreign.workspaceId],
    ] as const) {
      await expectAppError(
        createClip(
          c.app,
          user,
          workspaceId,
          { sourceAssetId: sourceId, startMs: 1000, endMs: 4000 },
          meta,
        ),
        'not_found',
      );
      await expectAppError(getClip(c.app, user, workspaceId, created.clipId), 'not_found');
      await expectAppError(
        updateClip(c.app, user, workspaceId, created.clipId, edit({ endMs: 4500 }), meta),
        'not_found',
      );
      await expectAppError(
        importCaptions(c.app, user, workspaceId, created.clipId, srt),
        'not_found',
      );
    }
    await expectAppError(
      listClips(c.app, restricted, t.workspaceId, { pageId: t.pageId }),
      'not_found',
    );
    await expectAppError(listClips(c.app, foreign.owner, t.workspaceId, {}), 'not_found');
    expect(
      (await listClips(c.app, restricted, t.workspaceId, { sourceAssetId: sourceId })).clips,
    ).toEqual([]);
    expect((await listClips(c.app, foreign.owner, foreign.workspaceId, {})).clips).toEqual([]);

    // Nothing above changed the clip.
    const detail = await getClip(c.app, t.owner, t.workspaceId, created.clipId);
    expect(detail.clip.version).toBe(1);
    expect(await revisionRows(created.clipId)).toHaveLength(1);
  });

  it('lets a viewer read a clip but not create or edit one', async () => {
    const created = await manualClip();
    const viewer = await join('viewer', { allPages: true, pageIds: [] });
    expect((await getClip(c.app, viewer, t.workspaceId, created.clipId)).clip.id).toBe(
      created.clipId,
    );
    expect(
      (await listClips(c.app, viewer, t.workspaceId, { pageId: t.pageId })).clips.some(
        (clip) => clip.id === created.clipId,
      ),
    ).toBe(true);
    await expectAppError(
      createClip(
        c.app,
        viewer,
        t.workspaceId,
        { sourceAssetId: sourceId, startMs: 1000, endMs: 4000 },
        meta,
      ),
      'forbidden',
    );
    await expectAppError(
      updateClip(c.app, viewer, t.workspaceId, created.clipId, edit({ endMs: 4500 }), meta),
      'forbidden',
    );
  });
});
