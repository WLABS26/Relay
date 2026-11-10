import { NextResponse, type NextRequest } from 'next/server';
import { configGate, renderConfigErrorPage } from '@/lib/server/config-gate';

/**
 * Security headers and a per-request CSP nonce for every page. Next.js applies the nonce to
 * its own scripts when it sees it on the request. Style attributes (React `style` props) need
 * 'unsafe-inline' for styles only; scripts stay strictly nonce-bound with 'strict-dynamic'.
 */
export function proxy(request: NextRequest) {
  // Invalid configuration: a readable page instead of the platform's generic error.
  const gate = configGate();
  if (!gate.ok) {
    return new NextResponse(renderConfigErrorPage(gate), {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '60',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      },
    });
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const https = (process.env.RELAY_PUBLIC_URL ?? '').startsWith('https://');
  const media = (() => {
    try {
      return process.env.S3_PUBLIC_ENDPOINT ? new URL(process.env.S3_PUBLIC_ENDPOINT).origin : '';
    } catch {
      return '';
    }
  })();
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: ${media}`.trim(),
    `media-src 'self' blob: ${media}`.trim(),
    `connect-src 'self' ${media}${isDev ? ' ws: wss:' : ''}`.trim(),
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-relay-path', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (https)
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
