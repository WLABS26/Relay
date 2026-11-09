'use client';

import type { ErrorEnvelope } from '@relay/domain';

/** Error thrown for non-2xx API responses, carrying the standard envelope. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors?: Record<string, string[]>;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
  constructor(status: number, envelope: Partial<ErrorEnvelope>) {
    super(envelope.message ?? 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope.code ?? 'internal_error';
    if (envelope.fieldErrors) this.fieldErrors = envelope.fieldErrors;
    if (envelope.details) this.details = envelope.details;
    if (envelope.requestId) this.requestId = envelope.requestId;
  }
}

function csrfToken(): string {
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith('relay_csrf=') || c.startsWith('__Host-relay_csrf='));
  return match ? decodeURIComponent(match.slice(match.indexOf('=') + 1)) : '';
}

/** Map a non-JSON (gateway or proxy) response onto the stable error codes. */
function gatewayEnvelope(status: number): Partial<ErrorEnvelope> {
  if (status === 413)
    return {
      code: 'payload_too_large',
      message: 'That request was too large for the server to accept.',
    };
  if (status === 429)
    return { code: 'rate_limited', message: 'Too many requests. Wait a moment and try again.' };
  if (status >= 500)
    return {
      code: 'service_unavailable',
      message: `Relay is temporarily unavailable (HTTP ${status}). Try again shortly.`,
    };
  return { code: 'internal_error', message: 'The server sent a response Relay could not read.' };
}

export function newIdempotencyKey(prefix = 'web'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A proxy or gateway answered with something other than the API's JSON envelope.
      throw new ApiError(response.status, gatewayEnvelope(response.status));
    }
  }
  if (!response.ok) throw new ApiError(response.status, data as Partial<ErrorEnvelope>);
  return data as T;
}

/** Bounded exponential-backoff polling (initial client update strategy). */
export async function poll<T>(
  fetcher: () => Promise<T>,
  done: (value: T) => boolean,
  options: { initialMs?: number; maxMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const started = Date.now();
  let delay = options.initialMs ?? 750;
  for (;;) {
    const value = await fetcher();
    if (done(value)) return value;
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() - started > (options.timeoutMs ?? 120_000)) return value;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(options.maxMs ?? 5000, Math.round(delay * 1.6));
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return error.requestId && error.status >= 500
      ? `${error.message} (request ${error.requestId})`
      : error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
