import pino, { type Logger } from 'pino';

/**
 * Structured, sanitised logging. Never log request bodies, cookies, tokens, signed URLs, raw
 * chat or provider payloads. `redactUrl` strips query strings (presigned signatures) and
 * `safeError` keeps only a bounded message without upstream bodies.
 */

export type { Logger };

const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'headers.cookie',
  'headers.authorization',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.password',
  '*.codeVerifier',
  '*.url',
  '*.uploadUrl',
];

export function createLogger(options: {
  level: string;
  service: string;
  pretty?: boolean;
}): Logger {
  return pino({
    level: options.level,
    base: { service: options.service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** Remove query string and fragment (signatures, tokens) from a URL before logging it. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?[redacted]' : ''}`;
  } catch {
    return '[invalid-url]';
  }
}

export function safeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message.slice(0, 300),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'UnknownError', message: String(error).slice(0, 300) };
}
