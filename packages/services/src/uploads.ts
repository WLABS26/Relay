import { sql, withTenant, type Tx } from '@relay/db';
import {
  AppError,
  allowedTypeFor,
  completeUploadSchema,
  createUploadSchema,
  extensionOf,
  sanitizeFilename,
  signPartsSchema,
} from '@relay/domain';
import { assetOriginalKey, isNotFound, isPreconditionFailed } from '@relay/media';
import { authorize, inWorkspace, loadMember, memberActor, requirePage, type AuthenticatedUser, type Member } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { withIdempotency } from './idempotency';
import { createJobRun } from './jobs';
import { enqueue } from './tasks';

/**
 * Uploads: reserve quota → presigned single PUT or multipart with server-planned parts →
 * complete (verify parts and final size against the storage provider, never the client) →
 * quarantine (status "validating") → the media worker validates the actual bytes.
 */

export const FIRST_PARTY_STATEMENT = {
  version: 'first-party-v1',
  text: 'I own this media, or I am authorised by its owner, to upload, edit and publish it for this workspace. Third-party audio, video or overlays inside it are covered by that authorisation.',
} as const;

export interface UploadStartResponse {
  uploadId: string;
  assetId: string;
  strategy: 'single' | 'multipart';
  expiresAt: string;
  single?: { url: string; method: 'PUT'; headers: Record<string, string> };
  multipart?: { partSize: number; partCount: number; lastPartSize: number };
}

async function workspaceStorageUsage(tx: Tx): Promise<{ used: number; quota: number }> {
  const usage = await sql<{ used: string; quota: string }>`
    SELECT
      COALESCE((SELECT sum(size_bytes) FROM media_assets WHERE status IN ('validating', 'ready')), 0)
      + COALESCE((SELECT sum(size_bytes) FROM media_variants), 0)
      + COALESCE((SELECT sum(reserved_bytes) FROM upload_sessions WHERE reservation_released_at IS NULL), 0) AS used,
      (SELECT storage_quota_bytes FROM workspaces WHERE id = relay_current_workspace_id()) AS quota`.execute(tx);
  return { used: Number(usage.rows[0]!.used), quota: Number(usage.rows[0]!.quota) };
}

function planParts(size: number, partSize: number): { partCount: number; lastPartSize: number } {
  const partCount = Math.ceil(size / partSize);
  return { partCount, lastPartSize: size - (partCount - 1) * partSize };
}

export async function startUpload(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta & { idempotencyKey?: string | null },
): Promise<{ status: number; body: UploadStartResponse; replayed: boolean }> {
  const input = createUploadSchema.parse(rawInput);
  const type = allowedTypeFor(input.mimeType);
  if (!type) {
    throw new AppError('unsupported_media_type', `${input.mimeType} is not supported. Upload MP4, MOV or WebM video, or JPEG, PNG or WebP images.`);
  }
  const ext = extensionOf(input.filename);
  if (ext && !type.extensions.includes(ext)) {
    throw new AppError('unsupported_media_type', `The file extension .${ext} does not match ${input.mimeType}.`);
  }
  const maxBytes = type.kind === 'video' ? ctx.config.uploads.maxVideoBytes : ctx.config.uploads.maxImageBytes;
  if (input.sizeBytes > maxBytes) {
    throw new AppError('payload_too_large', `${type.kind === 'video' ? 'Videos' : 'Images'} can be at most ${Math.floor(maxBytes / 1024 ** 2)} MiB.`);
  }
  if (!input.pageId) throw new AppError('validation_failed', 'Choose a page for this upload.', { fieldErrors: { pageId: ['Required'] } });

  // Cheap pre-check (authorization, page, quota) before touching storage.
  await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'media.upload', input.pageId);
    await requirePage(tx, member, input.pageId!);
  });

  const assetId = ctx.ids.next();
  const uploadId = ctx.ids.next();
  const key = assetOriginalKey(workspaceId, assetId, 1, type.extensions[0]!);
  const strategy: 'single' | 'multipart' = input.sizeBytes <= ctx.config.uploads.singleUploadMaxBytes ? 'single' : 'multipart';
  const partSize = ctx.config.uploads.multipartPartBytes;
  const plan = planParts(input.sizeBytes, partSize);
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + ctx.config.storage.uploadSessionTtlSeconds * 1000);

  // Storage call happens outside the database transaction; the multipart upload is aborted
  // again if the transaction does not commit (or turns out to be an idempotent replay).
  const s3UploadId = strategy === 'multipart' ? await ctx.storage.createMultipart({ key, contentType: input.mimeType }) : null;
  let committed = false;
  try {
    const result = await withTenant(ctx.db, { workspaceId, userId: user.userId }, async (tx) => {
      const member = await loadMember(tx, workspaceId, user);
      authorize(member, 'media.upload', input.pageId);
      return withIdempotency(
        tx,
        { workspaceId, operation: 'uploads.create', key: meta.idempotencyKey, actorUserId: user.userId, payload: input },
        async () => {
          // Quota is checked under a per-workspace advisory lock so concurrent uploads cannot
          // jointly overshoot it.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${workspaceId}`}, 0))`.execute(tx);
          const { used, quota } = await workspaceStorageUsage(tx);
          if (used + input.sizeBytes > quota) {
            throw new AppError('quota_exceeded', 'This upload would exceed the workspace storage quota.', {
              details: { usedBytes: used, quotaBytes: quota, requestedBytes: input.sizeBytes },
            });
          }
          await tx
            .insertInto('mediaAssets')
            .values({
              id: assetId,
              workspaceId,
              pageId: input.pageId!,
              kind: type.kind,
              status: 'uploading',
              originalFilename: sanitizeFilename(input.filename),
              declaredMime: input.mimeType,
              sizeBytes: input.sizeBytes,
              objectKey: key,
              createdBy: user.userId,
            })
            .execute();
          await tx
            .insertInto('sourceRightsGrants')
            .values({
              id: ctx.ids.next(),
              workspaceId,
              assetId,
              grantType: 'first_party_declaration',
              grantorUserId: user.userId,
              statementVersion: input.declaration.statementVersion,
              statement: FIRST_PARTY_STATEMENT.text,
              evidencePointer: input.declaration.evidence ?? null,
              canView: true,
              canEdit: true,
              canExport: true,
              canPublish: true,
              canCommercialUse: input.declaration.commercialUse,
              permittedProviders: null,
              // Business timestamps come from the injected clock, never DB defaults, so
              // rights validity is evaluated on one consistent timeline.
              validFrom: now,
            })
            .execute();
          await tx
            .insertInto('uploadSessions')
            .values({
              id: uploadId,
              workspaceId,
              assetId,
              pageId: input.pageId!,
              createdBy: user.userId,
              strategy,
              status: 'pending',
              objectKey: key,
              s3UploadId,
              declaredMime: input.mimeType,
              declaredSize: input.sizeBytes,
              checksumSha256: input.checksumSha256 ?? null,
              partSize: strategy === 'multipart' ? partSize : null,
              partCount: strategy === 'multipart' ? plan.partCount : null,
              reservedBytes: input.sizeBytes,
              expiresAt,
            })
            .execute();
          if (strategy === 'multipart') {
            const rows = Array.from({ length: plan.partCount }, (_, i) => ({
              workspaceId,
              uploadSessionId: uploadId,
              partNumber: i + 1,
              expectedSize: i + 1 === plan.partCount ? plan.lastPartSize : partSize,
            }));
            for (let i = 0; i < rows.length; i += 1000) await tx.insertInto('uploadSessionParts').values(rows.slice(i, i + 1000)).execute();
          }
          await appendAudit(tx, ctx.ids, {
            workspaceId,
            actor: memberActor(member),
            action: 'upload.started',
            entityType: 'media_asset',
            entityId: assetId,
            pageId: input.pageId,
            data: { strategy, sizeBytes: input.sizeBytes, mime: input.mimeType, declaration: input.declaration.statementVersion },
            requestId: meta.requestId,
          });
          const body: UploadStartResponse = {
            uploadId,
            assetId,
            strategy,
            expiresAt: expiresAt.toISOString(),
            ...(strategy === 'multipart' ? { multipart: { partSize, partCount: plan.partCount, lastPartSize: plan.lastPartSize } } : {}),
          };
          return { status: 201, body };
        },
      );
    });
    committed = !result.replayed;
    // Presigned single-PUT URLs are minted per response (never stored for replay).
    if (result.body.strategy === 'single') {
      const session = await withTenant(ctx.db, { workspaceId, userId: user.userId }, (tx) =>
        tx.selectFrom('uploadSessions').select(['objectKey', 'declaredSize', 'declaredMime', 'checksumSha256', 'status']).where('id', '=', result.body.uploadId).executeTakeFirstOrThrow(),
      );
      if (session.status === 'pending') {
        const signed = await ctx.storage.presignPut({
          key: session.objectKey,
          contentLength: session.declaredSize,
          contentType: session.declaredMime,
          ...(session.checksumSha256 ? { checksumSha256: session.checksumSha256 } : {}),
          expiresInSeconds: ctx.config.storage.uploadUrlTtlSeconds,
        });
        result.body.single = { url: signed.url, method: 'PUT', headers: signed.headers };
      }
    }
    return result;
  } finally {
    if (s3UploadId && !committed) await ctx.storage.abortMultipart({ key, uploadId: s3UploadId }).catch(() => undefined);
  }
}

async function loadSessionForUpdate(tx: Tx, member: Member, uploadId: string) {
  const session = await tx.selectFrom('uploadSessions').selectAll().where('id', '=', uploadId).forUpdate().executeTakeFirst();
  if (!session) throw new AppError('not_found', 'Upload not found');
  authorize(member, 'media.upload', session.pageId);
  return session;
}

export async function signUploadParts(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, uploadId: string, rawInput: unknown) {
  const input = signPartsSchema.parse(rawInput);
  const { session, parts } = await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const session = await loadSessionForUpdate(tx, member, uploadId);
    if (session.strategy !== 'multipart' || !session.s3UploadId) throw new AppError('upload_state_invalid', 'This upload does not use parts.');
    if (session.status !== 'pending') throw new AppError('upload_state_invalid', 'This upload is no longer accepting parts.');
    if (session.expiresAt <= ctx.clock.now()) throw new AppError('upload_expired', 'This upload session expired. Start the upload again.');
    const numbers = [...new Set(input.partNumbers)].sort((a, b) => a - b);
    if (numbers.some((n) => n > (session.partCount ?? 0))) {
      throw new AppError('validation_failed', `Part numbers must be between 1 and ${session.partCount}.`, { fieldErrors: { partNumbers: ['Out of range'] } });
    }
    const parts = await tx
      .updateTable('uploadSessionParts')
      .set({ signedCount: sql`signed_count + 1`, lastSignedAt: ctx.clock.now() })
      .where('uploadSessionId', '=', uploadId)
      .where('partNumber', 'in', numbers)
      .returning(['partNumber', 'expectedSize'])
      .execute();
    return { session, parts };
  });
  const expiresInSeconds = Math.min(
    ctx.config.storage.uploadUrlTtlSeconds,
    Math.max(60, Math.floor((session.expiresAt.getTime() - ctx.clock.now().getTime()) / 1000)),
  );
  const signed = await Promise.all(
    parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(async (p) => ({
        partNumber: p.partNumber,
        size: p.expectedSize,
        url: await ctx.storage.presignPart({ key: session.objectKey, uploadId: session.s3UploadId!, partNumber: p.partNumber, contentLength: p.expectedSize, expiresInSeconds }),
      })),
  );
  return { parts: signed, expiresAt: new Date(ctx.clock.now().getTime() + expiresInSeconds * 1000).toISOString() };
}

async function failUpload(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  session: { id: string; assetId: string; objectKey: string; s3UploadId: string | null; pageId: string },
  code: 'upload_incomplete' | 'upload_size_mismatch',
  detail: string,
  meta: RequestMeta,
): Promise<never> {
  await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const now = ctx.clock.now();
    await tx.updateTable('uploadSessions').set({ status: 'failed', failureCode: code, endedAt: now, reservationReleasedAt: now }).where('id', '=', session.id).execute();
    await tx.updateTable('mediaAssets').set({ status: 'rejected', rejectionCode: code, rejectionDetail: detail.slice(0, 500) }).where('id', '=', session.assetId).execute();
    await appendAudit(tx, ctx.ids, { workspaceId, actor: memberActor(member), action: 'upload.failed', entityType: 'media_asset', entityId: session.assetId, pageId: session.pageId, data: { code }, requestId: meta.requestId });
  });
  if (session.s3UploadId) await ctx.storage.abortMultipart({ key: session.objectKey, uploadId: session.s3UploadId }).catch(() => undefined);
  await ctx.storage.deleteAllVersions(session.objectKey).catch(() => undefined);
  throw new AppError(code, detail);
}

export async function completeUpload(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  uploadId: string,
  rawInput: unknown,
  meta: RequestMeta,
): Promise<{ assetId: string; status: string; jobId: string | null }> {
  const input = completeUploadSchema.parse(rawInput ?? {});
  const now = ctx.clock.now();
  // Phase 1: claim the session for completion (serialises concurrent completes).
  const session = await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const s = await loadSessionForUpdate(tx, member, uploadId);
    if (s.status === 'completed') return { ...s, alreadyCompleted: true as const };
    const stuckCompleting = s.status === 'completing' && now.getTime() - s.updatedAt.getTime() > 120_000;
    if (s.status !== 'pending' && !stuckCompleting) throw new AppError('upload_state_invalid', `This upload is ${s.status}.`);
    if (s.expiresAt <= now) throw new AppError('upload_expired', 'This upload session expired. Start the upload again.');
    await tx.updateTable('uploadSessions').set({ status: 'completing' }).where('id', '=', s.id).execute();
    return { ...s, alreadyCompleted: false as const };
  });
  if (session.alreadyCompleted) {
    const job = await inWorkspace(ctx, user, workspaceId, (tx) =>
      tx.selectFrom('jobRuns').select('id').where('entityType', '=', 'media_asset').where('entityId', '=', session.assetId).orderBy('createdAt', 'desc').executeTakeFirst(),
    );
    return { assetId: session.assetId, status: 'validating', jobId: job?.id ?? null };
  }

  // Phase 2: verify against storage (outside any transaction).
  if (session.strategy === 'multipart') {
    const listed = await ctx.storage.listParts({ key: session.objectKey, uploadId: session.s3UploadId! }).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!listed) return failUpload(ctx, user, workspaceId, session, 'upload_incomplete', 'The storage provider no longer has this upload.', meta);
    const expected = await inWorkspace(ctx, user, workspaceId, (tx) =>
      tx.selectFrom('uploadSessionParts').select(['partNumber', 'expectedSize']).where('uploadSessionId', '=', uploadId).orderBy('partNumber').execute(),
    );
    if (listed.length !== expected.length) {
      return failUpload(ctx, user, workspaceId, session, 'upload_incomplete', `Expected ${expected.length} parts, storage has ${listed.length}.`, meta);
    }
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i]!;
      const got = listed[i]!;
      if (got.partNumber !== want.partNumber || got.size !== want.expectedSize) {
        return failUpload(ctx, user, workspaceId, session, 'upload_size_mismatch', `Part ${want.partNumber} has the wrong size.`, meta);
      }
      const claimed = input.parts?.find((p) => p.partNumber === want.partNumber);
      if (claimed && claimed.etag.replaceAll('"', '') !== got.etag.replaceAll('"', '')) {
        return failUpload(ctx, user, workspaceId, session, 'upload_incomplete', `Part ${want.partNumber} does not match what the browser uploaded.`, meta);
      }
    }
    try {
      await ctx.storage.completeMultipart({ key: session.objectKey, uploadId: session.s3UploadId!, parts: listed });
    } catch (error) {
      // An object already exists at this one-time key: never let a second completion replace it.
      if (isPreconditionFailed(error)) {
        return failUpload(ctx, user, workspaceId, session, 'upload_incomplete', 'An object already exists for this upload.', meta);
      }
      if (!isNotFound(error)) throw error;
    }
    await inWorkspace(ctx, user, workspaceId, async (tx) => {
      for (const part of listed) {
        await tx
          .updateTable('uploadSessionParts')
          .set({ etag: part.etag, sizeBytes: part.size, verifiedAt: ctx.clock.now() })
          .where('uploadSessionId', '=', uploadId)
          .where('partNumber', '=', part.partNumber)
          .execute();
      }
    });
  }
  const head = await ctx.storage.head(session.objectKey);
  if (!head) return failUpload(ctx, user, workspaceId, session, 'upload_incomplete', 'The file never reached storage.', meta);
  if (head.size !== session.declaredSize) {
    return failUpload(ctx, user, workspaceId, session, 'upload_size_mismatch', `Expected ${session.declaredSize} bytes, storage has ${head.size}.`, meta);
  }

  // Phase 3: quarantine + enqueue validation in one transaction.
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    await tx.updateTable('uploadSessions').set({ status: 'completed', completedAt: ctx.clock.now(), endedAt: ctx.clock.now() }).where('id', '=', uploadId).execute();
    await tx
      .updateTable('mediaAssets')
      .set({ status: 'validating', objectEtag: head.etag, objectVersionId: head.versionId })
      .where('id', '=', session.assetId)
      .where('status', '=', 'uploading')
      .execute();
    const jobId = await createJobRun(tx, ctx, { workspaceId, kind: 'asset.probe', entityType: 'media_asset', entityId: session.assetId, correlationId: meta.requestId });
    await enqueue(tx, 'asset.probe', { workspaceId, assetId: session.assetId, uploadSessionId: uploadId, correlationId: meta.requestId }, { jobKey: `asset.probe:${session.assetId}`, jobKeyMode: 'unsafe_dedupe' });
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'upload.completed',
      entityType: 'media_asset',
      entityId: session.assetId,
      pageId: session.pageId,
      data: { sizeBytes: head.size, strategy: session.strategy },
      requestId: meta.requestId,
    });
    return { assetId: session.assetId, status: 'validating', jobId };
  });
}

export async function abortUpload(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, uploadId: string, meta: RequestMeta) {
  const session = await inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const s = await loadSessionForUpdate(tx, member, uploadId);
    if (s.status !== 'pending' && s.status !== 'completing') throw new AppError('upload_state_invalid', `This upload is ${s.status}.`);
    const now = ctx.clock.now();
    await tx.updateTable('uploadSessions').set({ status: 'aborted', endedAt: now, reservationReleasedAt: now }).where('id', '=', s.id).execute();
    await tx.updateTable('mediaAssets').set({ status: 'deleted', deletedAt: now }).where('id', '=', s.assetId).execute();
    await appendAudit(tx, ctx.ids, { workspaceId, actor: memberActor(member), action: 'upload.aborted', entityType: 'media_asset', entityId: s.assetId, pageId: s.pageId, requestId: meta.requestId });
    return s;
  });
  if (session.s3UploadId) await ctx.storage.abortMultipart({ key: session.objectKey, uploadId: session.s3UploadId }).catch(() => undefined);
  await ctx.storage.deleteAllVersions(session.objectKey).catch(() => undefined);
  return { aborted: true };
}
