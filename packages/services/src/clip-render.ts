import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sql, withTenant, type Tx } from '@relay/db';
import {
  AppError,
  allowedTypeFor,
  CLIP_PROFILE,
  clipFrameCount,
  clipGeometry,
  cuesForRender,
  requestRenderSchema,
  sanitizeFilename,
  sniffContainer,
  toAss,
  validateProbe,
  type ClipAspect,
  type ClipCaptionCue,
  type ClipCaptionStyle,
  type ClipCropMode,
  type ProbeSummary,
} from '@relay/domain';
import { renderKey } from '@relay/domain/server';
import {
  assetOriginalKey,
  assetVariantKey,
  CLIP_CAPTIONS_FILE,
  CLIP_RENDERER_VERSION,
  ClipRenderInputError,
  ClipVerificationError,
  clipRendererVersion,
  ffmpegVersion,
  ffprobeVersion,
  ObjectTooLargeError,
  probeFile,
  renderClip,
  renderProxy,
  renderThumbnail,
  scanIsoBmffProtection,
  stageCaptionFonts,
  ToolError,
  verifyClipOutput,
} from '@relay/media';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser } from './access';
import { appendAudit, SERVICE_ACTORS } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { withIdempotency } from './idempotency';
import { createJobRun, updateJobRun } from './jobs';
import { safeError } from './logger';
import { Rejection, sanitizeProbe, toolConfig } from './media-pipeline';
import { evaluateRights, RIGHTS_PROBLEM_LABELS } from './rights';
import { enqueue, type TaskPayload } from './tasks';
import { lockWorkspaceQuota, workspaceStorageUsage } from './uploads';

/**
 * clip.render: turn one clip revision into a new, derived media asset.
 *
 * The app role records the request (`requestClipRender`): it reserves quota and inserts the
 * output asset as `validating` with `origin = 'render'`, because the worker role may not
 * insert assets. The media worker (`processClipRender`) then decodes the pinned original,
 * re-encodes the range through the FFmpeg sandbox, verifies the result and moves the output
 * asset to `ready` or `rejected`, exactly as `asset.probe` does for an upload.
 *
 * The source is only ever read. The derived asset holds no rights of its own: `evaluateRights`
 * resolves it to its source through the render job, so revoking the source blocks the clip.
 */

const OUTPUT_MIME = 'video/mp4';
const OUTPUT_DEMUXER = 'mov';
const THUMBNAIL_PROFILE = 'jpg-640';
const PROXY_PROFILE = 'h264-960';

/**
 * The most a render can produce, for the quota reservation: the encoder's rate cap (8 Mbit/s
 * video, 128 kbit/s audio) with a tenth on top for the container, plus the 16 Mbit rate buffer
 * a short clip may spend at once. The render itself is cut off at the reserved size.
 */
const RESERVE_BYTES_PER_SECOND = Math.ceil(((8_000_000 + 128_000) / 8) * 1.1);
const RESERVE_FIXED_BYTES = 4 * 1024 * 1024;

export function clipReservedBytes(durationMs: number, maxOutputBytes: number): number {
  const estimate = Math.ceil((durationMs / 1000) * RESERVE_BYTES_PER_SECOND) + RESERVE_FIXED_BYTES;
  return Math.min(maxOutputBytes, estimate);
}

export type ClipRenderFailureCode =
  'rights_revoked' | 'source_changed' | 'media_not_ready' | 'render_failed' | 'processing_failed';

export interface RequestClipRenderResponse {
  renderJobId: string;
  clipId: string;
  revisionId: string;
  /** The derived asset; `validating` until the render finishes. */
  outputAssetId: string;
  /** The job that tracks this render (GET /jobs/:jobId), when one was recorded. */
  jobId: string | null;
  status: 'queued' | 'running' | 'succeeded';
}

async function requireRights(
  tx: Tx,
  ctx: ServiceContext,
  assetId: string,
  operation: 'edit' | 'export',
): Promise<void> {
  const rights = await evaluateRights(tx, {
    assetIds: [assetId],
    operation,
    at: ctx.clock.now(),
  });
  if (rights.ok) return;
  const reason = rights.problems[0]?.reason ?? 'no_grant';
  throw new AppError(
    'rights_missing',
    reason === 'operation_denied'
      ? operation === 'edit'
        ? 'The recorded rights do not allow editing this media.'
        : 'The recorded rights do not allow exporting this media.'
      : RIGHTS_PROBLEM_LABELS[reason],
    { details: { problems: rights.problems } },
  );
}

function outputFilename(title: string): string {
  // 120 characters at most, extension included.
  return `${sanitizeFilename(title).slice(0, 116).trim() || 'clip'}.mp4`;
}

/**
 * Ask for a render of a clip revision (the current one unless `revisionId` is given). An
 * identical edit of the same source bytes is rendered once: when a queued, running or finished
 * job has the same render key, that job and its output asset are returned (200). Otherwise the
 * output asset and the job are recorded and `clip.render` is enqueued (202).
 */
export async function requestClipRender(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  clipId: string,
  rawInput: unknown,
  meta: RequestMeta & { idempotencyKey?: string | null },
): Promise<{ status: number; body: RequestClipRenderResponse; replayed: boolean }> {
  const input = requestRenderSchema.parse(rawInput ?? {});
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const clip = await tx
      .selectFrom('clipProjects')
      .select(['id', 'pageId', 'sourceAssetId', 'sourceAssetVersion', 'title', 'currentRevisionId'])
      .where('id', '=', clipId)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
    if (!clip) throw new AppError('not_found', 'Clip not found');
    authorize(member, 'content.create', clip.pageId);
    return withIdempotency<RequestClipRenderResponse>(
      tx,
      {
        workspaceId,
        operation: 'clips.render',
        key: meta.idempotencyKey,
        actorUserId: user.userId,
        payload: { clipId, ...input },
      },
      async () => {
        const revisionId = input.revisionId ?? clip.currentRevisionId;
        const revision = revisionId
          ? await tx
              .selectFrom('clipRevisions')
              .select(['id', 'clipId', 'startMs', 'endMs', 'editHash'])
              .where('id', '=', revisionId)
              .executeTakeFirst()
          : undefined;
        if (!revision || revision.clipId !== clip.id)
          throw new AppError('validation_failed', 'That revision does not belong to this clip.', {
            fieldErrors: { revisionId: ['Unknown revision'] },
          });

        const source = await tx
          .selectFrom('mediaAssets')
          .select([
            'id',
            'pageId',
            'kind',
            'status',
            'origin',
            'version',
            'sha256',
            'width',
            'height',
            'durationMs',
            'isSample',
            'rightsVersion',
          ])
          .where('id', '=', clip.sourceAssetId)
          .executeTakeFirst();
        if (!source || source.status === 'deleted')
          throw new AppError('not_found', 'Clip not found');
        if (
          source.status !== 'ready' ||
          source.kind !== 'video' ||
          source.origin === 'render' ||
          !source.sha256 ||
          !source.durationMs ||
          !source.width ||
          !source.height
        )
          throw new AppError('media_not_ready', 'The source video is not available for rendering.');
        if (source.version !== clip.sourceAssetVersion)
          throw new AppError(
            'validation_failed',
            'The source video changed after this clip was made. Create the clip again.',
          );
        // The stored range was validated when it was saved; durations are immutable, so this
        // only fires on data that was not written through updateClip.
        if (revision.endMs > source.durationMs)
          throw new AppError('validation_failed', 'This range cannot be used for a clip.', {
            fieldErrors: { endMs: ['The end is past the end of the source'] },
          });
        await requireRights(tx, ctx, source.id, 'edit');

        const key = renderKey({
          editHash: revision.editHash,
          profile: CLIP_PROFILE,
          sourceAssetId: source.id,
          sourceAssetVersion: source.version,
          sourceSha256: source.sha256,
          // The recipe, not the tool build: the web process that takes this request has no
          // FFmpeg to ask. The worker records the exact tool on the job.
          rendererVersion: CLIP_RENDERER_VERSION,
        });
        // Two identical requests must not both pass the "is there one already" check; the
        // partial unique index would reject the second insert and abort its transaction.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`render:${workspaceId}:${key}`}, 0))`.execute(
          tx,
        );
        const existing = await tx
          .selectFrom('renderJobs')
          .select(['id', 'revisionId', 'outputAssetId', 'status'])
          .where('renderKey', '=', key)
          .where('status', 'in', ['queued', 'running', 'succeeded'])
          .executeTakeFirst();
        if (existing) {
          const job = await tx
            .selectFrom('jobRuns')
            .select('id')
            .where('entityType', '=', 'render_job')
            .where('entityId', '=', existing.id)
            .orderBy('createdAt', 'desc')
            .executeTakeFirst();
          return {
            status: 200,
            body: {
              renderJobId: existing.id,
              clipId: clip.id,
              revisionId: existing.revisionId,
              outputAssetId: existing.outputAssetId,
              jobId: job?.id ?? null,
              status: existing.status as RequestClipRenderResponse['status'],
            },
          };
        }

        const reservedBytes = clipReservedBytes(
          revision.endMs - revision.startMs,
          ctx.config.media.clipMaxOutputBytes,
        );
        await lockWorkspaceQuota(tx, workspaceId);
        const { used, quota } = await workspaceStorageUsage(tx);
        if (used + reservedBytes > quota)
          throw new AppError(
            'quota_exceeded',
            'Rendering this clip would exceed the workspace storage quota.',
            { details: { usedBytes: used, quotaBytes: quota, requestedBytes: reservedBytes } },
          );

        const outputAssetId = ctx.ids.next();
        const renderJobId = ctx.ids.next();
        // Inserted directly as `validating`: there is no upload to wait for, and the reserved
        // size counts against the quota until the worker replaces it with the real one.
        await tx
          .insertInto('mediaAssets')
          .values({
            id: outputAssetId,
            workspaceId,
            pageId: clip.pageId,
            kind: 'video',
            status: 'validating',
            origin: 'render',
            originalFilename: outputFilename(clip.title),
            declaredMime: OUTPUT_MIME,
            sizeBytes: reservedBytes,
            objectKey: assetOriginalKey(workspaceId, outputAssetId, 1, 'mp4'),
            isSample: source.isSample,
            createdBy: user.userId,
          })
          .execute();
        await tx
          .insertInto('renderJobs')
          .values({
            id: renderJobId,
            workspaceId,
            clipId: clip.id,
            revisionId: revision.id,
            profile: CLIP_PROFILE,
            renderKey: key,
            status: 'queued',
            sourceAssetId: source.id,
            sourceAssetVersion: source.version,
            sourceRightsVersion: source.rightsVersion,
            outputAssetId,
            requestedBy: user.userId,
          })
          .execute();
        const jobId = await createJobRun(tx, ctx, {
          workspaceId,
          kind: 'clip.render',
          entityType: 'render_job',
          entityId: renderJobId,
          correlationId: meta.requestId,
        });
        await enqueue(
          tx,
          'clip.render',
          { workspaceId, renderJobId, correlationId: meta.requestId },
          { jobKey: `clip.render:${renderJobId}`, jobKeyMode: 'unsafe_dedupe' },
        );
        await appendAudit(tx, ctx.ids, {
          workspaceId,
          actor: memberActor(member),
          action: 'clip.render_requested',
          entityType: 'render_job',
          entityId: renderJobId,
          pageId: clip.pageId,
          data: {
            clipId: clip.id,
            revisionId: revision.id,
            sourceAssetId: source.id,
            outputAssetId,
            profile: CLIP_PROFILE,
          },
          requestId: meta.requestId,
        });
        return {
          status: 202,
          body: {
            renderJobId,
            clipId: clip.id,
            revisionId: revision.id,
            outputAssetId,
            jobId,
            status: 'queued',
          },
        };
      },
    );
  });
}

/**
 * The newest render of a clip and its output asset, for commands that need a finished render
 * (export, handoff to a post). Throws `media_not_ready` when there is none, it is still
 * running, or it failed.
 */
export async function requireFinishedRender(tx: Tx, clipId: string) {
  const render = await tx
    .selectFrom('renderJobs as r')
    .innerJoin('mediaAssets as a', 'a.id', 'r.outputAssetId')
    .select([
      'r.id',
      'r.revisionId',
      'r.status',
      'r.outputAssetId',
      'a.status as assetStatus',
      'a.objectKey',
      'a.objectVersionId',
      'a.originalFilename',
      'a.declaredMime',
      'a.sizeBytes',
    ])
    .where('r.clipId', '=', clipId)
    // IDs are UUIDv7 and break ties between jobs created in the same instant.
    .orderBy('r.createdAt', 'desc')
    .orderBy('r.id', 'desc')
    .executeTakeFirst();
  if (!render) throw new AppError('media_not_ready', 'Render this clip first.');
  if (render.status === 'failed' || render.assetStatus === 'rejected')
    throw new AppError('media_not_ready', 'The last render of this clip failed. Render it again.');
  if (render.status !== 'succeeded' || render.assetStatus !== 'ready')
    throw new AppError('media_not_ready', 'This clip is still being rendered.');
  return render;
}

/**
 * A short-lived download link for the rendered clip. Needs the export right on the source
 * (through the clip's lineage) at the moment of the request, and is audited.
 */
export async function exportClip(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  clipId: string,
  meta: RequestMeta,
): Promise<{
  url: string;
  expiresAt: string;
  assetId: string;
  revisionId: string;
  filename: string;
  sizeBytes: number;
}> {
  const target = await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const clip = await tx
      .selectFrom('clipProjects')
      .select(['id', 'pageId'])
      .where('id', '=', clipId)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
    if (!clip) throw new AppError('not_found', 'Clip not found');
    authorize(member, 'content.export', clip.pageId);
    const render = await requireFinishedRender(tx, clip.id);
    await requireRights(tx, ctx, render.outputAssetId, 'export');
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'clip.exported',
      entityType: 'clip_project',
      entityId: clip.id,
      pageId: clip.pageId,
      data: {
        renderJobId: render.id,
        revisionId: render.revisionId,
        assetId: render.outputAssetId,
        sizeBytes: Number(render.sizeBytes),
      },
      requestId: meta.requestId,
    });
    return render;
  });
  const signed = await ctx.storage.presignGet({
    key: target.objectKey,
    versionId: target.objectVersionId,
    expiresInSeconds: ctx.config.storage.mediaUrlTtlSeconds,
    contentType: target.declaredMime,
    disposition: 'attachment',
    filename: target.originalFilename,
  });
  return {
    ...signed,
    assetId: target.outputAssetId,
    revisionId: target.revisionId,
    filename: target.originalFilename,
    sizeBytes: Number(target.sizeBytes),
  };
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

const RIGHTS_REVOKED = 'The rights recorded for the source no longer allow editing it.';

/**
 * Worker handler for `clip.render`. The payload is a hint: the job, the revision, the source
 * and the rights are reloaded here, and a duplicate or late delivery is a no-op. Object keys
 * are fixed per job and write-once, so a redelivery after a crash adopts what the earlier
 * attempt already stored instead of storing it twice.
 */
export async function processClipRender(
  ctx: ServiceContext,
  payload: TaskPayload<'clip.render'>,
  attempt: { number: number; max: number },
): Promise<'succeeded' | 'failed' | 'skipped'> {
  const { workspaceId, renderJobId } = payload;
  const startedAt = ctx.clock.now();

  type Loaded =
    | { kind: 'skip' }
    | {
        kind: 'reject' | 'run';
        rejection: Rejection<ClipRenderFailureCode> | null;
        clipId: string;
        pageId: string;
        outputAssetId: string;
        outputKey: string;
        reservedBytes: number;
        revision: {
          id: string;
          startMs: number;
          endMs: number;
          aspect: ClipAspect;
          cropMode: ClipCropMode;
          captions: ClipCaptionCue[] | null;
          captionStyle: ClipCaptionStyle;
        };
        source: {
          id: string;
          declaredMime: string;
          objectKey: string;
          objectVersionId: string | null;
          objectEtag: string | null;
          sizeBytes: number;
          sha256: string | null;
        } | null;
      };

  const loaded = await withTenant(ctx.db, { workspaceId }, async (tx): Promise<Loaded> => {
    const job = await tx
      .selectFrom('renderJobs')
      .select([
        'id',
        'clipId',
        'revisionId',
        'status',
        'sourceAssetId',
        'sourceAssetVersion',
        'outputAssetId',
      ])
      .where('id', '=', renderJobId)
      .executeTakeFirst();
    // Stale, duplicate or already handled.
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return { kind: 'skip' };
    const output = await tx
      .selectFrom('mediaAssets')
      .select(['id', 'pageId', 'status', 'objectKey', 'sizeBytes'])
      .where('id', '=', job.outputAssetId)
      .executeTakeFirst();
    if (!output || output.status !== 'validating') return { kind: 'skip' };
    const revision = await tx
      .selectFrom('clipRevisions')
      .select(['id', 'startMs', 'endMs', 'aspect', 'cropMode', 'captions', 'captionStyle'])
      .where('id', '=', job.revisionId)
      .executeTakeFirstOrThrow();
    const source = await tx
      .selectFrom('mediaAssets')
      .select([
        'id',
        'kind',
        'status',
        'origin',
        'version',
        'declaredMime',
        'objectKey',
        'objectVersionId',
        'objectEtag',
        'sizeBytes',
        'sha256',
      ])
      .where('id', '=', job.sourceAssetId)
      .executeTakeFirst();

    const base = {
      clipId: job.clipId,
      pageId: output.pageId,
      outputAssetId: output.id,
      outputKey: output.objectKey,
      reservedBytes: Number(output.sizeBytes),
      revision: {
        ...revision,
        aspect: revision.aspect as ClipAspect,
        cropMode: revision.cropMode as ClipCropMode,
        captions: revision.captions as ClipCaptionCue[] | null,
        captionStyle: revision.captionStyle as ClipCaptionStyle,
      },
      source: source ? { ...source, sizeBytes: Number(source.sizeBytes) } : null,
    };
    const reject = (code: ClipRenderFailureCode, detail: string): Loaded => ({
      ...base,
      kind: 'reject',
      rejection: new Rejection(code, detail),
    });
    if (
      !source ||
      source.status !== 'ready' ||
      source.kind !== 'video' ||
      source.origin === 'render'
    )
      return reject('media_not_ready', 'The source video is no longer available.');
    if (source.version !== job.sourceAssetVersion)
      return reject('source_changed', 'The source video changed after the render was requested.');
    // Rights can be withdrawn between the request and the run; the worker never trusts the
    // decision made when the job was enqueued.
    const rights = await evaluateRights(tx, {
      assetIds: [source.id],
      operation: 'edit',
      at: ctx.clock.now(),
    });
    if (!rights.ok) return reject('rights_revoked', RIGHTS_REVOKED);

    await tx
      .updateTable('renderJobs')
      .set({ status: 'running', startedAt: sql`COALESCE(started_at, ${startedAt})` })
      .where('id', '=', renderJobId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
    await updateJobRun(tx, {
      entityType: 'render_job',
      entityId: renderJobId,
      kind: 'clip.render',
      status: 'running',
      progress: 5,
    });
    return { ...base, kind: 'run', rejection: null };
  });
  if (loaded.kind === 'skip') return 'skipped';

  const { outputAssetId, outputKey, revision } = loaded;
  const variantKeys = {
    thumbnail: assetVariantKey(
      workspaceId,
      outputAssetId,
      1,
      'thumbnail',
      THUMBNAIL_PROFILE,
      'jpg',
    ),
    proxy: assetVariantKey(workspaceId, outputAssetId, 1, 'proxy', PROXY_PROFILE, 'mp4'),
  };

  /**
   * Record a permanent failure and remove what was stored for the output. A no-op, objects
   * included, when the output asset already left `validating` (another delivery finished it).
   */
  const fail = async (
    rejection: Rejection<ClipRenderFailureCode>,
  ): Promise<'failed' | 'skipped'> => {
    const recorded = await withTenant(ctx.db, { workspaceId }, async (tx) => {
      const now = ctx.clock.now();
      const updated = await tx
        .updateTable('mediaAssets')
        .set({
          status: 'rejected',
          rejectionCode: rejection.code,
          rejectionDetail: rejection.detail.slice(0, 500),
        })
        .where('id', '=', outputAssetId)
        .where('status', '=', 'validating')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return false;
      await tx
        .updateTable('renderJobs')
        .set({
          status: 'failed',
          errorCode: rejection.code,
          errorDetail: rejection.detail.slice(0, 500),
          finishedAt: now,
        })
        .where('id', '=', renderJobId)
        .where('status', 'in', ['queued', 'running'])
        .execute();
      await updateJobRun(tx, {
        entityType: 'render_job',
        entityId: renderJobId,
        kind: 'clip.render',
        status: 'failed',
        errorCode: rejection.code,
        errorMessage: rejection.detail,
      });
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.media,
        action: 'clip.render_failed',
        entityType: 'render_job',
        entityId: renderJobId,
        pageId: loaded.pageId,
        data: { clipId: loaded.clipId, outputAssetId, code: rejection.code },
        correlationId: payload.correlationId ?? null,
      });
      return true;
    });
    if (!recorded) return 'skipped';
    // A failed render keeps no bytes: the clip and whatever derivatives were already stored.
    for (const key of [outputKey, variantKeys.thumbnail, variantKeys.proxy])
      await ctx.storage.deleteAllVersions(key).catch(() => undefined);
    return 'failed';
  };

  if (loaded.kind === 'reject' || !loaded.source) {
    return fail(
      loaded.rejection ??
        new Rejection<ClipRenderFailureCode>('media_not_ready', 'The source video is missing.'),
    );
  }
  const source = loaded.source;

  const cfg = toolConfig(ctx);
  const scratchRoot = ctx.config.media.scratchDir ?? tmpdir();
  // Created inside the try: a scratch volume that is full or missing on the last attempt must
  // still fail the render instead of leaving the output `validating` and its quota reserved.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(scratchRoot, 'relay-clip-'));
    const type = allowedTypeFor(source.declaredMime);
    if (!type || type.kind !== 'video' || !source.sha256)
      throw new Rejection<ClipRenderFailureCode>(
        'media_not_ready',
        'The source is not a validated video.',
      );

    // The renderer never trusts stored metadata: the exact validated bytes are fetched and
    // inspected again, the same way asset.probe did.
    const inputPath = path.join(dir, 'input');
    let download;
    try {
      download = await ctx.storage.downloadToFile({
        key: source.objectKey,
        versionId: source.objectVersionId,
        ifMatch: source.objectEtag,
        path: inputPath,
        maxBytes: source.sizeBytes,
      });
    } catch (error) {
      if (error instanceof ObjectTooLargeError)
        throw new Rejection<ClipRenderFailureCode>(
          'source_changed',
          'The stored source is larger than recorded.',
        );
      throw error;
    }
    if (download.bytes !== source.sizeBytes || download.sha256 !== source.sha256)
      throw new Rejection<ClipRenderFailureCode>(
        'source_changed',
        'The stored source no longer matches the video that was validated.',
      );
    const container = sniffContainer(download.head);
    if (!type.containers.includes(container))
      throw new Rejection<ClipRenderFailureCode>(
        'source_changed',
        'The stored source is not the declared kind of file.',
      );
    if (container === 'mp4' || container === 'mov') {
      const protection = await scanIsoBmffProtection(inputPath);
      if (protection.encrypted || !protection.complete)
        throw new Rejection<ClipRenderFailureCode>(
          'render_failed',
          'The source cannot be inspected safely, so it was not rendered.',
        );
    }
    let sourceProbe: ProbeSummary;
    try {
      sourceProbe = await probeFile(cfg, inputPath, type.demuxer);
    } catch (error) {
      if (error instanceof ToolError)
        throw new Rejection<ClipRenderFailureCode>(
          'render_failed',
          'The source could not be read as valid media.',
        );
      throw error;
    }
    const caps = {
      maxVideoDurationMs: ctx.config.uploads.maxVideoDurationMs,
      maxVideoDimension: ctx.config.uploads.maxVideoDimension,
      maxImagePixels: ctx.config.uploads.maxImagePixels,
      maxStreams: 8,
    };
    const validation = validateProbe('video', sourceProbe, caps);
    if (!validation.ok)
      throw new Rejection<ClipRenderFailureCode>('render_failed', validation.detail);
    const media = validation.media;
    if (!media.durationMs || revision.endMs > media.durationMs)
      throw new Rejection<ClipRenderFailureCode>(
        'render_failed',
        'The clip range ends after the end of the source.',
      );

    const geometry = clipGeometry({
      sourceWidth: media.width,
      sourceHeight: media.height,
      aspect: revision.aspect,
      cropMode: revision.cropMode,
    });
    const expected = {
      width: geometry.outWidth,
      height: geometry.outHeight,
      frameCount: clipFrameCount(revision.startMs, revision.endMs),
      hasAudio: media.hasAudio,
    };
    const outputPath = path.join(dir, 'clip.mp4');

    interface Stored {
      probe: ProbeSummary;
      sha256: string;
      size: number;
      versionId: string | null;
      etag: string | null;
    }
    /** The clip a previous attempt of this job already stored, checked like a fresh render. */
    const adoptStored = async (): Promise<Stored | null> => {
      const head = await ctx.storage.head(outputKey);
      if (!head) return null;
      try {
        const existing = await ctx.storage.downloadToFile({
          key: outputKey,
          versionId: head.versionId,
          path: outputPath,
          maxBytes: loaded.reservedBytes,
        });
        const probe = await verifyClipOutput(cfg, outputPath, expected);
        return {
          probe,
          sha256: existing.sha256,
          size: existing.bytes,
          versionId: head.versionId,
          etag: head.etag,
        };
      } catch (error) {
        if (!(error instanceof ClipVerificationError) && !(error instanceof ObjectTooLargeError))
          throw error;
        // Not the clip this job describes: discard it and render again.
        await ctx.storage.deleteAllVersions(outputKey);
        await rm(outputPath, { force: true });
        return null;
      }
    };

    let stored = await adoptStored();
    if (!stored) {
      // FFmpeg works in a directory of its own, which holds only the caption side files.
      const renderDir = path.join(dir, 'render');
      await mkdir(renderDir);
      const cues = revision.captions
        ? cuesForRender(revision.captions, revision.startMs, revision.endMs)
        : [];
      if (cues.length > 0) {
        await stageCaptionFonts({ fontsDir: ctx.config.media.fontsDir, scratchDir: renderDir });
        await writeFile(
          path.join(renderDir, CLIP_CAPTIONS_FILE),
          toAss(cues, {
            width: geometry.outWidth,
            height: geometry.outHeight,
            style: revision.captionStyle,
          }),
        );
      }
      await renderClip(cfg, {
        inputPath,
        demuxer: type.demuxer,
        outputPath,
        scratchDir: renderDir,
        startMs: revision.startMs,
        endMs: revision.endMs,
        geometry,
        hasAudio: media.hasAudio,
        captions: cues.length > 0,
        // Never more than was reserved against the quota when the render was requested.
        maxOutputBytes: loaded.reservedBytes,
      });
      const probe = await verifyClipOutput(cfg, outputPath, expected);
      const sha256 = await sha256OfFile(outputPath);
      const { size } = await stat(outputPath);
      try {
        const put = await ctx.storage.uploadFile({
          key: outputKey,
          path: outputPath,
          contentType: OUTPUT_MIME,
        });
        stored = { probe, sha256, size, versionId: put.versionId, etag: put.etag };
      } catch (error) {
        // The key is write-once: a concurrent or earlier attempt stored the clip first. Its
        // bytes are the asset, so they replace the local file and are hashed and verified.
        stored = await adoptStored();
        if (!stored) throw error;
      }
    }
    const clip = stored;

    const outputValidation = validateProbe('video', clip.probe, caps);
    if (!outputValidation.ok)
      throw new Rejection<ClipRenderFailureCode>('render_failed', outputValidation.detail);
    const out = outputValidation.media;

    // Thumbnail and playback proxy, so the clip previews like any upload.
    const probeVersion = await ffprobeVersion(cfg);
    const rendererVersion = clipRendererVersion(await ffmpegVersion(cfg));
    const thumbPath = path.join(dir, 'thumbnail.jpg');
    await renderThumbnail(cfg, {
      path: outputPath,
      demuxer: OUTPUT_DEMUXER,
      kind: 'video',
      durationMs: out.durationMs,
      outputPath: thumbPath,
      maxSide: 640,
    });
    const proxyPath = path.join(dir, 'proxy.mp4');
    await renderProxy(cfg, {
      path: outputPath,
      demuxer: OUTPUT_DEMUXER,
      outputPath: proxyPath,
      maxSide: 960,
      maxOutputBytes: Math.max(64 * 1024 ** 2, clip.size),
    });
    const variants = [
      {
        kind: 'thumbnail' as const,
        profile: THUMBNAIL_PROFILE,
        file: thumbPath,
        mime: 'image/jpeg',
        key: variantKeys.thumbnail,
      },
      {
        kind: 'proxy' as const,
        profile: PROXY_PROFILE,
        file: proxyPath,
        mime: 'video/mp4',
        key: variantKeys.proxy,
      },
    ];
    const variantRows: Array<
      (typeof variants)[number] & { size: number; versionId: string | null }
    > = [];
    for (const v of variants) {
      let put;
      try {
        put = await ctx.storage.uploadFile({ key: v.key, path: v.file, contentType: v.mime });
      } catch (error) {
        // A retry after a crash may find the derivative already stored at its unique key.
        const existing = await ctx.storage.head(v.key);
        if (!existing) throw error;
        put = { etag: existing.etag, versionId: existing.versionId, size: existing.size };
      }
      variantRows.push({ ...v, size: put.size, versionId: put.versionId });
    }

    return await withTenant(ctx.db, { workspaceId }, async (tx) => {
      const now = ctx.clock.now();
      // A revoke during a long render must not produce a ready asset.
      const rights = await evaluateRights(tx, {
        assetIds: [source.id],
        operation: 'edit',
        at: now,
      });
      if (!rights.ok) throw new Rejection<ClipRenderFailureCode>('rights_revoked', RIGHTS_REVOKED);
      const updated = await tx
        .updateTable('mediaAssets')
        .set({
          status: 'ready',
          detectedContainer: 'mp4',
          sha256: clip.sha256,
          sizeBytes: clip.size,
          objectVersionId: clip.versionId,
          objectEtag: clip.etag,
          width: out.width,
          height: out.height,
          durationMs: out.durationMs,
          hasAudio: out.hasAudio,
          videoCodec: out.videoCodec,
          audioCodec: out.audioCodec,
          frameRate: out.frameRate === null ? null : String(out.frameRate),
          rotation: out.rotation,
          pixFmt: out.pixFmt,
          probe: JSON.stringify(sanitizeProbe(clip.probe)),
          ffprobeVersion: probeVersion,
          validatedAt: now,
        })
        .where('id', '=', outputAssetId)
        .where('status', '=', 'validating')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return 'skipped'; // another delivery finished (or failed) it first
      for (const v of variantRows) {
        await tx
          .insertInto('mediaVariants')
          .values({
            id: ctx.ids.next(),
            workspaceId,
            assetId: outputAssetId,
            kind: v.kind,
            profile: v.profile,
            objectKey: v.key,
            objectVersionId: v.versionId,
            mime: v.mime,
            sizeBytes: v.size,
            rendererVersion,
            ...(v.kind === 'proxy' ? { durationMs: out.durationMs } : {}),
          })
          .onConflict((oc) => oc.columns(['assetId', 'kind', 'profile']).doNothing())
          .execute();
      }
      await tx
        .updateTable('renderJobs')
        .set({
          status: 'succeeded',
          outputProbe: JSON.stringify(sanitizeProbe(clip.probe)),
          rendererVersion,
          renderMs: Math.max(0, now.getTime() - startedAt.getTime()),
          errorCode: null,
          errorDetail: null,
          finishedAt: now,
        })
        .where('id', '=', renderJobId)
        .where('status', '=', 'running')
        .execute();
      const clipSeconds = (revision.endMs - revision.startMs) / 1000;
      for (const usage of [
        { kind: 'media_seconds_processed', quantity: String(clipSeconds) },
        { kind: 'export_bytes', quantity: String(clip.size) },
      ]) {
        await tx
          .insertInto('usageEvents')
          .values({
            id: ctx.ids.next(),
            workspaceId,
            kind: usage.kind,
            quantity: usage.quantity,
            entityType: 'render_job',
            entityId: renderJobId,
          })
          .execute();
      }
      await updateJobRun(tx, {
        entityType: 'render_job',
        entityId: renderJobId,
        kind: 'clip.render',
        status: 'succeeded',
        progress: 100,
      });
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.media,
        action: 'clip.rendered',
        entityType: 'render_job',
        entityId: renderJobId,
        pageId: loaded.pageId,
        data: {
          clipId: loaded.clipId,
          revisionId: revision.id,
          sourceAssetId: source.id,
          outputAssetId,
          width: out.width,
          height: out.height,
          durationMs: out.durationMs,
          hasAudio: out.hasAudio,
          sizeBytes: clip.size,
          rendererVersion,
        },
        correlationId: payload.correlationId ?? null,
      });
      return 'succeeded';
    });
  } catch (error) {
    let rejection: Rejection<ClipRenderFailureCode> | null = null;
    if (error instanceof Rejection) {
      rejection = error as Rejection<ClipRenderFailureCode>;
    } else if (error instanceof ClipVerificationError) {
      // The same input renders the same file; a retry cannot fix it.
      rejection = new Rejection('render_failed', 'The rendered clip did not match the request.');
    } else if (error instanceof ClipRenderInputError) {
      rejection = new Rejection(
        'render_failed',
        'Captions cannot be rendered on this deployment (the caption font is missing).',
      );
    } else if (error instanceof RangeError) {
      rejection = new Rejection('render_failed', 'This clip cannot be rendered as described.');
    } else if (attempt.number >= attempt.max) {
      rejection = new Rejection(
        'processing_failed',
        'Relay could not render this clip after several attempts.',
      );
    }
    if (!rejection) {
      ctx.logger.warn(
        { renderJobId, err: safeError(error), attempt: attempt.number },
        'clip.render failed; will retry',
      );
      throw error; // let the queue retry with backoff
    }
    if (!(error instanceof Rejection))
      ctx.logger.warn({ renderJobId, err: safeError(error) }, 'clip.render failed permanently');
    return await fail(rejection);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
