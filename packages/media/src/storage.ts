import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RelayConfig } from '@relay/config';

/**
 * Private object storage over the S3 API (AWS SDK v3). Bytes are streamed; nothing is
 * buffered whole in memory. Two clients exist because presigned URLs must be signed for the
 * host the browser (or provider) will contact, which differs from the internal endpoint in
 * container deployments.
 */

export interface HeadResult {
  size: number;
  etag: string | null;
  versionId: string | null;
  contentType: string | null;
}

export interface PartInfo {
  partNumber: number;
  etag: string;
  size: number;
}

export class ObjectTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`object exceeds ${limit} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}

export class ObjectStorage {
  readonly bucket: string;
  private readonly internal: S3Client;
  private readonly presigner: S3Client;

  constructor(config: RelayConfig['storage']) {
    this.bucket = config.bucket;
    const base = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      // Only send checksums when an operation requires them, so browser PUTs to presigned
      // URLs do not need SDK-computed checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      ...(config.accessKeyId && config.secretAccessKey
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
    };
    this.internal = new S3Client({ ...base, ...(config.endpoint ? { endpoint: config.endpoint } : {}) });
    this.presigner = new S3Client({
      ...base,
      ...(config.publicEndpoint ? { endpoint: config.publicEndpoint } : config.endpoint ? { endpoint: config.endpoint } : {}),
    });
  }

  /**
   * Presigned single PUT. Binds content length and type, and requires If-None-Match: * so a
   * replayed or late PUT can never overwrite an object that already exists.
   */
  async presignPut(input: {
    key: string;
    contentLength: number;
    contentType: string;
    checksumSha256?: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const url = await getSignedUrl(
      this.presigner,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        IfNoneMatch: '*',
        ...(input.checksumSha256 ? { ChecksumSHA256: input.checksumSha256 } : {}),
      }),
      { expiresIn: input.expiresInSeconds, signableHeaders: new Set(['content-type', 'if-none-match']) },
    );
    return { url, headers: { 'content-type': input.contentType, 'if-none-match': '*' } };
  }

  async createMultipart(input: { key: string; contentType: string }): Promise<string> {
    const out = await this.internal.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: input.key, ContentType: input.contentType }),
    );
    if (!out.UploadId) throw new Error('storage did not return an UploadId');
    return out.UploadId;
  }

  /** Presigned URL for exactly one server-planned part, with its exact byte length bound. */
  async presignPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        ContentLength: input.contentLength,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async listParts(input: { key: string; uploadId: string }): Promise<PartInfo[]> {
    const parts: PartInfo[] = [];
    let marker: string | undefined;
    for (;;) {
      const out = await this.internal.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: input.key, UploadId: input.uploadId, PartNumberMarker: marker }),
      );
      for (const p of out.Parts ?? []) {
        if (p.PartNumber && p.ETag && p.Size !== undefined) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
      }
      if (!out.IsTruncated || !out.NextPartNumberMarker) break;
      marker = out.NextPartNumberMarker;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(input: { key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> }): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        IfNoneMatch: '*',
        MultipartUpload: { Parts: input.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(input: { key: string; uploadId: string }): Promise<void> {
    try {
      await this.internal.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: input.key, UploadId: input.uploadId }));
    } catch (error) {
      if (isNotFound(error)) return; // already aborted or completed
      throw error;
    }
  }

  async head(key: string, versionId?: string | null): Promise<HeadResult | null> {
    try {
      const out = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
      );
      return {
        size: out.ContentLength ?? 0,
        etag: out.ETag ?? null,
        versionId: out.VersionId ?? null,
        contentType: out.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Short-lived GET URL for one exact object version (never a listing, never public). */
  async presignGet(input: {
    key: string;
    versionId?: string | null;
    expiresInSeconds: number;
    contentType?: string;
    disposition?: 'inline' | 'attachment';
    filename?: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const disposition = input.disposition ?? 'inline';
    const safeName = (input.filename ?? 'media').replace(/[^\w.-]+/g, '_').slice(0, 80);
    const url = await getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ...(input.versionId ? { VersionId: input.versionId } : {}),
        ...(input.contentType ? { ResponseContentType: input.contentType } : {}),
        ResponseContentDisposition: `${disposition}; filename="${safeName}"`,
        ResponseCacheControl: 'private, max-age=60',
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString() };
  }

  /**
   * Stream an exact object version to a local file, hashing on the fly and aborting as soon as
   * more than `maxBytes` arrive. `ifMatch` pins the bytes validated at upload completion.
   */
  async downloadToFile(input: {
    key: string;
    path: string;
    maxBytes: number;
    versionId?: string | null;
    ifMatch?: string | null;
  }): Promise<{ bytes: number; sha256: string; head: Buffer }> {
    const out = await this.internal.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ...(input.versionId ? { VersionId: input.versionId } : {}),
        ...(input.ifMatch ? { IfMatch: input.ifMatch } : {}),
      }),
    );
    if (!out.Body) throw new Error('empty object body');
    const hash = createHash('sha256');
    let bytes = 0;
    const headChunks: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > input.maxBytes) {
          cb(new ObjectTooLargeError(input.maxBytes));
          return;
        }
        if (headLen < 64) {
          headChunks.push(chunk.subarray(0, 64 - headLen));
          headLen += Math.min(chunk.length, 64 - headLen);
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(out.Body as Readable, meter, createWriteStream(input.path, { flags: 'wx', mode: 0o600 }));
    return { bytes, sha256: hash.digest('hex'), head: Buffer.concat(headChunks) };
  }

  /** Upload a local file (derivatives); refuses to overwrite an existing key. */
  async uploadFile(input: { key: string; path: string; contentType: string }): Promise<{ etag: string | null; versionId: string | null; size: number }> {
    const { size } = await stat(input.path);
    const out = await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: createReadStream(input.path),
        ContentLength: size,
        ContentType: input.contentType,
        IfNoneMatch: '*',
      }),
    );
    return { etag: out.ETag ?? null, versionId: out.VersionId ?? null, size };
  }

  /** Small in-memory upload (fixtures, tests). */
  async putBytes(input: { key: string; body: Buffer; contentType: string }): Promise<{ etag: string | null; versionId: string | null }> {
    const out = await this.internal.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: input.key, Body: input.body, ContentType: input.contentType, IfNoneMatch: '*' }),
    );
    return { etag: out.ETag ?? null, versionId: out.VersionId ?? null };
  }

  /** Delete every version of a key (versioned buckets keep old versions otherwise). */
  async deleteAllVersions(key: string): Promise<number> {
    let deleted = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const out = await this.internal.send(
        new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
      );
      const entries = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].filter((v) => v.Key === key);
      for (const v of entries) {
        await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: v.VersionId }));
        deleted++;
      }
      if (!out.IsTruncated) break;
      keyMarker = out.NextKeyMarker;
      versionMarker = out.NextVersionIdMarker;
    }
    if (deleted === 0) {
      await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
    }
    return deleted;
  }

  /** Idempotent bucket provisioning: create, enable versioning, apply CORS. */
  async ensureBucket(corsOrigins: string[]): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    await this.internal.send(
      new PutBucketVersioningCommand({ Bucket: this.bucket, VersioningConfiguration: { Status: 'Enabled' } }),
    );
    await this.internal.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: corsOrigins,
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['content-type', 'content-length', 'if-none-match', 'x-amz-checksum-sha256', 'x-amz-sdk-checksum-algorithm'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    );
  }

  async ping(): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

export function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return error.$metadata.httpStatusCode === 404 || ['NotFound', 'NoSuchKey', 'NoSuchUpload'].includes(error.name);
  }
  return false;
}

export function isPreconditionFailed(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412;
}
