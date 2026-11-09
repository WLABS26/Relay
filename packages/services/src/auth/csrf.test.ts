import { describe, expect, it } from 'vitest';
import { csrfTokenFor, verifyCsrfToken } from './sessions';

const SECRET = 'unit-test-session-secret-0123456789abcdef';

describe('CSRF double-submit token', () => {
  it('is bound to the session and the server secret', () => {
    const token = csrfTokenFor(SECRET, 'session-a');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256-bit HMAC, base64url
    expect(verifyCsrfToken(SECRET, 'session-a', token)).toBe(true);
    expect(verifyCsrfToken(SECRET, 'session-b', token)).toBe(false); // another session's token
    expect(verifyCsrfToken(`${SECRET}-rotated`, 'session-a', token)).toBe(false); // secret rotation invalidates
  });

  it('refuses missing, empty, truncated and oversized tokens', () => {
    const token = csrfTokenFor(SECRET, 'session-a');
    for (const bad of [null, undefined, '', token.slice(0, -1), `${token}x`, 'x'.repeat(10_000)]) {
      expect(verifyCsrfToken(SECRET, 'session-a', bad)).toBe(false);
    }
  });
});
