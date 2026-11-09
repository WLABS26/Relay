'use client';

import { apiFetch } from './api';

/**
 * Browser upload engine: asks Relay for a session, sends bytes straight to private storage
 * over short-lived presigned URLs (single PUT, or server-planned multipart parts with bounded
 * concurrency and retry), then asks Relay to verify and quarantine. File bytes never pass
 * through the web server.
 */

interface StartResponse {
  uploadId: string;
  assetId: string;
  strategy: 'single' | 'multipart';
  single?: { url: string; headers: Record<string, string> };
  multipart?: { partSize: number; partCount: number; lastPartSize: number };
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

function putWithProgress(url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader('ETag')) : reject(new Error(`Storage refused the upload (${xhr.status}).`)));
    xhr.onerror = () => reject(new Error('Network error while uploading.'));
    xhr.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      last = error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

export async function uploadFile(input: {
  workspaceId: string;
  pageId: string;
  file: File;
  declaration: { confirmed: true; statementVersion: string; commercialUse: boolean };
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<{ assetId: string; uploadId: string; jobId: string | null }> {
  const base = `/api/v1/workspaces/${input.workspaceId}`;
  const start = await apiFetch<StartResponse>(`${base}/uploads`, {
    body: {
      pageId: input.pageId,
      filename: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      sizeBytes: input.file.size,
      declaration: input.declaration,
    },
    idempotencyKey: `upload-${crypto.randomUUID()}`,
  });
  const total = input.file.size;
  const report = (loaded: number) => input.onProgress?.({ loaded: Math.min(loaded, total), total });
  try {
    let parts: Array<{ partNumber: number; etag: string }> | undefined;
    if (start.single) {
      const single = start.single;
      await withRetry(() => putWithProgress(single.url, input.file, single.headers, report, input.signal));
    } else if (start.multipart) {
      const { partSize, partCount } = start.multipart;
      const loadedByPart = new Map<number, number>();
      const sum = () => [...loadedByPart.values()].reduce((a, b) => a + b, 0);
      parts = [];
      const queue = Array.from({ length: partCount }, (_, i) => i + 1);
      const concurrency = Math.min(4, partCount);
      const signBatch = async (numbers: number[]) =>
        apiFetch<{ parts: Array<{ partNumber: number; url: string; size: number }> }>(`${base}/uploads/${start.uploadId}/parts`, { body: { partNumbers: numbers } });
      const workerLoop = async () => {
        for (;;) {
          const next = queue.shift();
          if (next === undefined) return;
          const etag = await withRetry(async () => {
            const { parts: [signed] } = await signBatch([next]);
            const blob = input.file.slice((next - 1) * partSize, Math.min(next * partSize, total));
            return putWithProgress(signed!.url, blob, {}, (loaded) => {
              loadedByPart.set(next, loaded);
              report(sum());
            }, input.signal);
          });
          if (!etag) throw new Error('Storage did not return a part ETag (check bucket CORS ExposeHeaders).');
          parts!.push({ partNumber: next, etag });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, workerLoop));
      parts.sort((a, b) => a.partNumber - b.partNumber);
    }
    report(total);
    const done = await apiFetch<{ assetId: string; jobId: string | null }>(`${base}/uploads/${start.uploadId}/complete`, { body: parts ? { parts } : {} });
    return { assetId: done.assetId, uploadId: start.uploadId, jobId: done.jobId };
  } catch (error) {
    await apiFetch(`${base}/uploads/${start.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}
