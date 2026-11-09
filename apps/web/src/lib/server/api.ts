import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { isConfigError } from '@relay/config';
import { AppError, isAppError, isUuid, type ErrorEnvelope } from '@relay/domain';
import {
  safeError,
  validateSession,
  verifyCsrfToken,
  type AuthenticatedUser,
  type ServiceContext,
  type SessionInfo,
} from '@relay/services';
import { webContext } from './context';
import { originAllowed } from './origin';
import type { CookieSpec } from './session';

/**
 * Route handler wrapper. Every API route: assigns a request ID, authenticates the session,
 * enforces CSRF defences on mutations (strict same-origin check + signed double-submit token
 * bound to the session), parses JSON with a size cap, maps errors to the standard envelope
 * and never leaks internal details, credentials or upstream payloads.
 */

const MAX_JSON_BYTES = 256 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,100}$/;

export interface ApiContext<P> {
  req: NextRequest;
  params: P;
  ctx: ServiceContext;
  session: SessionInfo | null;
  requestId: string;
  idempotencyKey: string | null;
  /** Parsed JSON body (empty object when absent). */
  body(): Promise<unknown>;
  query(): Record<string, string>;
}

export interface AuthedApiContext<P> extends ApiContext<P> {
  session: SessionInfo;
  user: AuthenticatedUser;
}

export class ApiResponse<T> {
  constructor(
    readonly body: T,
    readonly status = 200,
    readonly cookies: CookieSpec[] = [],
    readonly headers: Record<string, string> = {},
  ) {}
}

type Handler<P, A extends boolean> = (c: A extends true ? AuthedApiContext<P> : ApiContext<P>) => Promise<unknown>;

function errorEnvelope(error: unknown, requestId: string, ctx: ServiceContext | null): { status: number; body: ErrorEnvelope; headers: Record<string, string> } {
  if (isAppError(error)) {
    const headers: Record<string, string> = error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {};
    return { status: error.status, body: error.toEnvelope(requestId), headers };
  }
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join('.') || '_';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { status: 422, body: { code: 'validation_failed', message: 'Some fields need attention.', fieldErrors, requestId }, headers: {} };
  }
  if (isConfigError(error)) {
    console.error(error.message);
    return { status: 503, body: { code: 'service_unavailable', message: 'Relay is misconfigured.', requestId }, headers: {} };
  }
  ctx?.logger.error({ requestId, err: safeError(error) }, 'unhandled API error');
  return { status: 500, body: { code: 'internal_error', message: 'Something went wrong. Try again, or share the request ID with support.', requestId }, headers: {} };
}

function applyCookies(response: NextResponse, cookies: CookieSpec[]): void {
  for (const c of cookies) response.cookies.set(c.name, c.value, { httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, path: c.path, maxAge: c.maxAge });
}

export function isSameOrigin(req: NextRequest, publicOrigin: string): boolean {
  return originAllowed({ origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site') }, publicOrigin);
}

export function api<P = Record<string, string>, A extends boolean = true>(
  options: { auth?: A; csrf?: boolean },
  handler: Handler<P, A>,
) {
  const requireAuth = options.auth ?? true;
  return async (req: NextRequest, route: { params: Promise<P> }): Promise<NextResponse> => {
    const incoming = req.headers.get('x-request-id');
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    let ctx: ServiceContext | null = null;
    try {
      ctx = webContext();
      const params = await route.params;
      for (const [key, value] of Object.entries((params ?? {}) as Record<string, string>)) {
        if (/id$/i.test(key) && !isUuid(value)) throw new AppError('not_found', 'Not found');
      }
      const mutation = !SAFE_METHODS.has(req.method);
      if (mutation && !isSameOrigin(req, ctx.config.publicOrigin)) {
        throw new AppError('csrf_failed', 'Cross-site request refused.');
      }
      const session = await validateSession(ctx, req.cookies.get(ctx.config.session.cookieName)?.value);
      if (requireAuth && !session) throw new AppError('unauthenticated', 'Sign in to continue.');
      if (mutation && session && options.csrf !== false) {
        if (!verifyCsrfToken(ctx.config.session.secret, session.sessionId, req.headers.get('x-csrf-token'))) {
          throw new AppError('csrf_failed', 'Your session token is missing or stale. Reload the page and try again.');
        }
      }
      let parsedBody: unknown;
      const c: AuthedApiContext<P> = {
        req,
        params,
        ctx,
        session: session!,
        user: session?.user as AuthenticatedUser,
        requestId,
        idempotencyKey: req.headers.get('idempotency-key'),
        query: () => Object.fromEntries(req.nextUrl.searchParams.entries()),
        body: async () => {
          if (parsedBody !== undefined) return parsedBody;
          const type = req.headers.get('content-type') ?? '';
          const text = await req.text();
          if (text.length === 0) return (parsedBody = {});
          if (!type.includes('application/json')) throw new AppError('unsupported_media_type', 'Send JSON (Content-Type: application/json).');
          if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new AppError('payload_too_large', 'Request body is too large.');
          try {
            parsedBody = JSON.parse(text);
          } catch {
            throw new AppError('validation_failed', 'Request body is not valid JSON.');
          }
          return parsedBody;
        },
      };
      const result = await handler(c as never);
      const out = result instanceof ApiResponse ? result : new ApiResponse(result ?? { ok: true });
      const response = NextResponse.json(out.body, { status: out.status });
      applyCookies(response, out.cookies);
      for (const [k, v] of Object.entries(out.headers)) response.headers.set(k, v);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-request-id', requestId);
      response.headers.set('x-content-type-options', 'nosniff');
      return response;
    } catch (error) {
      const env = errorEnvelope(error, requestId, ctx);
      const response = NextResponse.json(env.body, { status: env.status });
      for (const [k, v] of Object.entries(env.headers)) response.headers.set(k, v);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-request-id', requestId);
      return response;
    }
  };
}

export function meta(c: { requestId: string; idempotencyKey?: string | null }) {
  return { requestId: c.requestId, idempotencyKey: c.idempotencyKey ?? null };
}
