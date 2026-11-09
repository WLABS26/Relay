import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withTenant } from '@relay/db';
import {
  allowedTypeFor,
  sniffContainer,
  validateProbe,
  type ProbeSummary,
  type ValidationFailureCode,
} from '@relay/domain';
import {
  assetVariantKey,
  ffprobeVersion,
  ObjectTooLargeError,
  probeFile,
  renderProxy,
  renderThumbnail,
  scanIsoBmffProtection,
  ToolError,
  type MediaToolConfig,
} from '@relay/media';
import { appendAudit, SERVICE_ACTORS } from './audit';
import type { ServiceContext } from './context';
import { updateJobRun } from './jobs';
import { safeError } from './logger';
import type { TaskPayload } from './tasks';

/**
 * asset.probe — validates the actual bytes of a quarantined upload in the media pool.
 *
 * Fetch the exact validated object version into an isolated scratch directory → hash it →
 * sniff the container from magic bytes (never the extension or declared type) → scan for
 * content protection → ffprobe with a forced demuxer → validate against caps → render a
 * thumbnail (and a playback proxy for video), which doubles as a decode check → mark ready.
 * Anything else is rejected with a specific code and the object is deleted.
 */

export const RENDERER_VERSION_PREFIX = 'relay-media@1';

class Rejection extends Error {
  constructor(
    readonly code: ValidationFailureCode | 'checksum_mismatch' | 'processing_failed',
    readonly detail: string,
  ) {
    super(detail);
  }
}

function toolConfig(ctx: ServiceContext): MediaToolConfig {
  return {
    ffmpegPath: ctx.config.media.ffmpegPath,
    ffprobePath: ctx.config.media.ffprobePath,
    timeoutSeconds: ctx.config.media.timeoutSeconds,
    memoryLimitMb: ctx.config.media.memoryLimitMb,
    threads: ctx.config.media.threads,
    usePrlimit: ctx.config.media.usePrlimit,
  };
}

/** Keep only normalised, non-identifying probe facts (drop tags, encoder strings, metadata). */
function sanitizeProbe(probe: ProbeSummary) {
  return {
    formatName: probe.formatName,
    durationMs: probe.durationMs,
    startTimeMs: probe.startTimeMs,
    bitRate: probe.bitRate,
    streams: probe.streams.map((s) => ({
      index: s.index,
      type: s.type,
      codec: s.codec,
      width: s.width ?? null,
      height: s.height ?? null,
      pixFmt: s.pixFmt ?? null,
      avgFrameRate: s.avgFrameRate ?? null,
      realFrameRate: s.realFrameRate ?? null,
      rotation: s.rotation ?? 0,
      channels: s.channels ?? null,
      sampleRate: s.sampleRate ?? null,
      startTimeMs: s.startTimeMs ?? null,
    })),
  };
}

export async function processAssetProbe(
  ctx: ServiceContext,
  payload: TaskPayload<'asset.probe'>,
  attempt: { number: number; max: number },
): Promise<'ready' | 'rejected' | 'skipped'> {
  const { workspaceId, assetId } = payload;
  const asset = await withTenant(ctx.db, { workspaceId }, async (tx) => {
    const row = await tx
      .selectFrom('mediaAssets')
      .selectAll()
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!row || row.status !== 'validating') return null; // stale, duplicate or already handled
    const session = await tx
      .selectFrom('uploadSessions')
      .select(['id', 'checksumSha256'])
      .where('assetId', '=', assetId)
      .executeTakeFirst();
    await updateJobRun(tx, {
      entityType: 'media_asset',
      entityId: assetId,
      kind: 'asset.probe',
      status: 'running',
      progress: 5,
    });
    return { ...row, declaredChecksum: session?.checksumSha256 ?? null };
  });
  if (!asset) return 'skipped';

  const type = allowedTypeFor(asset.declaredMime);
  const cfg = toolConfig(ctx);
  const scratchRoot = ctx.config.media.scratchDir ?? tmpdir();
  const dir = await mkdtemp(path.join(scratchRoot, 'relay-media-'));
  const uploaded: string[] = [];
  try {
    if (!type)
      throw new Rejection('unsupported_type', `${asset.declaredMime} is not an accepted type.`);
    const input = path.join(dir, 'input');
    let download;
    try {
      download = await ctx.storage.downloadToFile({
        key: asset.objectKey,
        versionId: asset.objectVersionId,
        ifMatch: asset.objectEtag,
        path: input,
        maxBytes: asset.sizeBytes,
      });
    } catch (error) {
      if (error instanceof ObjectTooLargeError)
        throw new Rejection('size_mismatch', 'The stored file is larger than declared.');
      throw error;
    }
    if (download.bytes !== asset.sizeBytes)
      throw new Rejection(
        'size_mismatch',
        `Expected ${asset.sizeBytes} bytes, received ${download.bytes}.`,
      );
    if (asset.declaredChecksum) {
      const computed = Buffer.from(download.sha256, 'hex').toString('base64');
      if (computed !== asset.declaredChecksum)
        throw new Rejection(
          'checksum_mismatch',
          'The file does not match the checksum sent with the upload.',
        );
    }

    const container = sniffContainer(download.head);
    if (!type.containers.includes(container)) {
      throw new Rejection(
        'mime_mismatch',
        `The file content (${container}) does not match the declared type ${asset.declaredMime}.`,
      );
    }
    if (container === 'mp4' || container === 'mov') {
      const protection = await scanIsoBmffProtection(input);
      if (protection.encrypted)
        throw new Rejection(
          'encrypted_media',
          'Encrypted or DRM-protected media cannot be processed.',
        );
      // Fail closed: a file whose structure could not be fully inspected is not accepted.
      if (!protection.complete)
        throw new Rejection(
          'malformed_media',
          'This file is structured in a way Relay cannot inspect safely.',
        );
    }

    let probe: ProbeSummary;
    try {
      probe = await probeFile(cfg, input, type.demuxer);
    } catch (error) {
      if (error instanceof ToolError)
        throw new Rejection('malformed_media', 'The file could not be read as valid media.');
      throw error;
    }
    const validation = validateProbe(type.kind, probe, {
      maxVideoDurationMs: ctx.config.uploads.maxVideoDurationMs,
      maxVideoDimension: ctx.config.uploads.maxVideoDimension,
      maxImagePixels: ctx.config.uploads.maxImagePixels,
      maxStreams: 8,
    });
    if (!validation.ok) throw new Rejection(validation.code, validation.detail);
    const media = validation.media;

    // Derivatives (also a full decode check for video).
    const version = await ffprobeVersion(cfg);
    const rendererVersion = `${RENDERER_VERSION_PREFIX} (${version})`;
    const thumbPath = path.join(dir, 'thumbnail.jpg');
    try {
      await renderThumbnail(cfg, {
        path: input,
        demuxer: type.demuxer,
        kind: type.kind,
        durationMs: media.durationMs,
        outputPath: thumbPath,
        maxSide: 640,
      });
    } catch (error) {
      if (error instanceof ToolError)
        throw new Rejection(
          'malformed_media',
          'A preview frame could not be decoded from this file.',
        );
      throw error;
    }
    const variants: Array<{
      kind: 'thumbnail' | 'proxy';
      profile: string;
      file: string;
      mime: string;
      ext: string;
    }> = [
      { kind: 'thumbnail', profile: 'jpg-640', file: thumbPath, mime: 'image/jpeg', ext: 'jpg' },
    ];
    if (type.kind === 'video') {
      const proxyPath = path.join(dir, 'proxy.mp4');
      try {
        await renderProxy(cfg, {
          path: input,
          demuxer: type.demuxer,
          outputPath: proxyPath,
          maxSide: 960,
          maxOutputBytes: Math.max(64 * 1024 ** 2, asset.sizeBytes),
        });
      } catch (error) {
        if (error instanceof ToolError)
          throw new Rejection('malformed_media', 'The video could not be fully decoded.');
        throw error;
      }
      variants.push({
        kind: 'proxy',
        profile: 'h264-960',
        file: proxyPath,
        mime: 'video/mp4',
        ext: 'mp4',
      });
    }
    const variantRows: Array<
      (typeof variants)[number] & { key: string; size: number; versionId: string | null }
    > = [];
    for (const v of variants) {
      const key = assetVariantKey(workspaceId, assetId, asset.version, v.kind, v.profile, v.ext);
      const { size } = await stat(v.file);
      let put;
      try {
        put = await ctx.storage.uploadFile({ key, path: v.file, contentType: v.mime });
      } catch (error) {
        // A retry after a crash may find the derivative already uploaded at its unique key.
        const existing = await ctx.storage.head(key);
        if (!existing) throw error;
        put = { etag: existing.etag, versionId: existing.versionId, size: existing.size };
      }
      uploaded.push(key);
      variantRows.push({ ...v, key, size, versionId: put.versionId });
    }

    await withTenant(ctx.db, { workspaceId }, async (tx) => {
      const now = ctx.clock.now();
      const updated = await tx
        .updateTable('mediaAssets')
        .set({
          status: 'ready',
          detectedContainer: container,
          sha256: download.sha256,
          width: media.width,
          height: media.height,
          durationMs: media.durationMs,
          hasAudio: media.hasAudio,
          videoCodec: media.videoCodec,
          audioCodec: media.audioCodec,
          frameRate: media.frameRate === null ? null : String(media.frameRate),
          rotation: media.rotation,
          pixFmt: media.pixFmt,
          probe: JSON.stringify(sanitizeProbe(probe)),
          ffprobeVersion: version,
          validatedAt: now,
        })
        .where('id', '=', assetId)
        .where('status', '=', 'validating')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return;
      for (const v of variantRows) {
        await tx
          .insertInto('mediaVariants')
          .values({
            id: ctx.ids.next(),
            workspaceId,
            assetId,
            kind: v.kind,
            profile: v.profile,
            objectKey: v.key,
            objectVersionId: v.versionId,
            mime: v.mime,
            sizeBytes: v.size,
            rendererVersion,
            ...(v.kind === 'proxy' ? { durationMs: media.durationMs } : {}),
          })
          .onConflict((oc) => oc.columns(['assetId', 'kind', 'profile']).doNothing())
          .execute();
      }
      await tx
        .updateTable('uploadSessions')
        .set({ reservationReleasedAt: now })
        .where('assetId', '=', assetId)
        .where('reservationReleasedAt', 'is', null)
        .execute();
      await tx
        .insertInto('usageEvents')
        .values({
          id: ctx.ids.next(),
          workspaceId,
          kind: 'upload_bytes',
          quantity: String(asset.sizeBytes),
          entityType: 'media_asset',
          entityId: assetId,
        })
        .execute();
      if (media.durationMs) {
        await tx
          .insertInto('usageEvents')
          .values({
            id: ctx.ids.next(),
            workspaceId,
            kind: 'media_seconds_processed',
            quantity: String(media.durationMs / 1000),
            entityType: 'media_asset',
            entityId: assetId,
          })
          .execute();
      }
      await updateJobRun(tx, {
        entityType: 'media_asset',
        entityId: assetId,
        kind: 'asset.probe',
        status: 'succeeded',
        progress: 100,
      });
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.media,
        action: 'asset.validated',
        entityType: 'media_asset',
        entityId: assetId,
        pageId: asset.pageId,
        data: {
          kind: type.kind,
          width: media.width,
          height: media.height,
          durationMs: media.durationMs,
          hasAudio: media.hasAudio,
        },
        correlationId: payload.correlationId ?? null,
      });
    });
    return 'ready';
  } catch (error) {
    const rejection =
      error instanceof Rejection
        ? error
        : attempt.number >= attempt.max
          ? new Rejection(
              'processing_failed',
              'Relay could not process this file after several attempts.',
            )
          : null;
    if (!rejection) {
      ctx.logger.warn(
        { assetId, err: safeError(error), attempt: attempt.number },
        'asset.probe failed; will retry',
      );
      throw error; // let the queue retry with backoff
    }
    await withTenant(ctx.db, { workspaceId }, async (tx) => {
      const now = ctx.clock.now();
      const updated = await tx
        .updateTable('mediaAssets')
        .set({
          status: 'rejected',
          rejectionCode: rejection.code,
          rejectionDetail: rejection.detail.slice(0, 500),
        })
        .where('id', '=', assetId)
        .where('status', '=', 'validating')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return;
      await tx
        .updateTable('uploadSessions')
        .set({ reservationReleasedAt: now })
        .where('assetId', '=', assetId)
        .where('reservationReleasedAt', 'is', null)
        .execute();
      await updateJobRun(tx, {
        entityType: 'media_asset',
        entityId: assetId,
        kind: 'asset.probe',
        status: 'failed',
        errorCode: rejection.code,
        errorMessage: rejection.detail,
      });
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.media,
        action: 'asset.rejected',
        entityType: 'media_asset',
        entityId: assetId,
        pageId: asset.pageId,
        data: { code: rejection.code },
        correlationId: payload.correlationId ?? null,
      });
    });
    // Rejected bytes are not kept: delete the original and any partial derivatives.
    await ctx.storage.deleteAllVersions(asset.objectKey).catch(() => undefined);
    for (const key of uploaded) await ctx.storage.deleteAllVersions(key).catch(() => undefined);
    return 'rejected';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
