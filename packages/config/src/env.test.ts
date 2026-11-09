import { describe, expect, it } from 'vitest';
import { ConfigError, isConfigError, parseConfig } from './env';

const KEY = Buffer.alloc(32, 7).toString('base64');

/** Minimal valid local configuration (placeholders only). */
const local = {
  RELAY_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  DATABASE_URL_APP: 'postgres://app:x@localhost/relay',
  DATABASE_URL_WORKER: 'postgres://worker:x@localhost/relay',
  S3_BUCKET: 'relay-unit',
  RELAY_ENCRYPTION_KEYS: `k1:${KEY}`,
};

/** A production configuration that satisfies every rule. */
const production = {
  ...local,
  NODE_ENV: 'production',
  RELAY_ENV: 'production',
  RELAY_PUBLIC_URL: 'https://relay.example',
  RELAY_ENCRYPTION_PROVIDER: 'kms',
  RELAY_ENCRYPTION_KEYS: '',
  RELAY_KMS_KEY_ID: 'kms-key',
  RELAY_OIDC_ISSUER: 'https://login.example',
  RELAY_OIDC_CLIENT_ID: 'client',
  RELAY_OIDC_CLIENT_SECRET: 'secret',
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('parseConfig', () => {
  it('parses a local configuration with safe defaults', () => {
    const c = parseConfig(local);
    expect(c).toMatchObject({
      env: 'local',
      isProduction: false,
      demoMode: false,
      publicOrigin: 'http://localhost:3000',
    });
    expect(c.session).toMatchObject({ cookieName: 'relay_session', secureCookies: false });
    expect(c.encryption.keyring).toEqual([{ kid: 'k1', key: Buffer.alloc(32, 7) }]);
    expect(c.worker.pools).toEqual(['general', 'media']);
    expect(Object.values(c.providers).every((p) => !p.enabled)).toBe(true);
    expect(c.ops.publishKillSwitch).toBe(false);
  });

  it('uses __Host- cookies whenever the public URL is https', () => {
    const c = parseConfig({
      ...local,
      RELAY_PUBLIC_URL: 'https://staging.relay.example',
      RELAY_ENV: 'staging',
    });
    expect(c.session).toMatchObject({
      cookieName: '__Host-relay_session',
      csrfCookieName: '__Host-relay_csrf',
      secureCookies: true,
    });
  });

  it('assumes production when NODE_ENV=production and RELAY_ENV is missing', () => {
    expect(problems({ ...local, NODE_ENV: 'production', RELAY_DEMO_MODE: 'true' })).toContain(
      'RELAY_DEMO_MODE must be false in production (demo sign-in and simulated providers are forbidden)',
    );
  });

  it('accepts a complete production configuration', () => {
    expect(problems(production)).toEqual([]);
    expect(parseConfig(production).oidc?.redirectUri).toBe(
      'https://relay.example/api/auth/oidc/callback',
    );
  });

  it.each<[string, Record<string, string>, string]>([
    ['demo mode', { RELAY_DEMO_MODE: 'true' }, 'RELAY_DEMO_MODE must be false in production'],
    [
      'plain-http public URL',
      { RELAY_PUBLIC_URL: 'http://relay.example' },
      'RELAY_PUBLIC_URL must use https in production',
    ],
    [
      'default session secret',
      { RELAY_SESSION_SECRET: 'relay-dev-session-secret-change-me-0123456789abcdef' },
      'RELAY_SESSION_SECRET is a known development default',
    ],
    [
      'default database password',
      { DATABASE_URL_APP: 'postgres://relay_app:relay-dev-app@db/relay' },
      'DATABASE_URL_APP contains a known development default',
    ],
    [
      'default storage key',
      { S3_ACCESS_KEY_ID: 'relay-dev-access', S3_SECRET_ACCESS_KEY: 'x' },
      'S3_ACCESS_KEY_ID contains a known development default',
    ],
    [
      'local keyring',
      { RELAY_ENCRYPTION_PROVIDER: 'local', RELAY_ENCRYPTION_KEYS: `k1:${KEY}` },
      'RELAY_ENCRYPTION_PROVIDER must be "kms" in production',
    ],
    [
      'missing OIDC',
      { RELAY_OIDC_ISSUER: '', RELAY_OIDC_CLIENT_ID: '', RELAY_OIDC_CLIENT_SECRET: '' },
      'OIDC sign-in (RELAY_OIDC_*) must be configured in production',
    ],
    [
      'http OIDC issuer',
      { RELAY_OIDC_ISSUER: 'http://login.example' },
      'RELAY_OIDC_ISSUER must use https in production',
    ],
    [
      'http storage endpoint',
      { S3_ENDPOINT: 'http://minio:9000' },
      'S3_ENDPOINT must use https in production',
    ],
  ])('fails closed in production on %s', (_, patch, message) => {
    expect(problems({ ...production, ...patch }).join('\n')).toContain(message);
  });

  it('lists every problem at once, not just the first', () => {
    const found = problems({
      ...production,
      RELAY_DEMO_MODE: 'true',
      RELAY_PUBLIC_URL: 'http://relay.example',
    });
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['a short session secret', { RELAY_SESSION_SECRET: 'too-short' }, /at least 32 characters/],
    ['a malformed boolean', { RELAY_DEMO_MODE: 'maybe' }, /expected a boolean/],
    ['a non-integer', { RELAY_DB_POOL_MAX: '10.5' }, /non-negative integer/],
    ['an out-of-range integer', { RELAY_DB_POOL_MAX: '0' }, /RELAY_DB_POOL_MAX/],
    ['an unknown worker pool', { RELAY_WORKER_POOLS: 'general,gpu' }, /unknown pool "gpu"/],
    [
      'a 16-byte encryption key',
      { RELAY_ENCRYPTION_KEYS: `k1:${Buffer.alloc(16).toString('base64')}` },
      /exactly 32 bytes/,
    ],
    ['a key without an id', { RELAY_ENCRYPTION_KEYS: KEY }, /<kid>:<base64-32-byte-key>/],
    [
      'no keyring for local encryption',
      { RELAY_ENCRYPTION_KEYS: '' },
      /RELAY_ENCRYPTION_KEYS is required/,
    ],
    [
      'partial OIDC settings',
      { RELAY_OIDC_ISSUER: 'https://login.example' },
      /must be set together/,
    ],
    [
      'an access key without its secret',
      { S3_ACCESS_KEY_ID: 'id' },
      /S3_SECRET_ACCESS_KEY is required/,
    ],
    [
      'more than 10,000 multipart parts',
      {
        RELAY_MAX_VIDEO_BYTES: String(100 * 1024 ** 3),
        RELAY_MULTIPART_PART_BYTES: String(5 * 1024 ** 2),
      },
      /10,000-part/,
    ],
    ['a non-http public URL', { RELAY_PUBLIC_URL: 'ftp://relay.example' }, /RELAY_PUBLIC_URL/],
  ])('rejects %s in any environment', (_, patch, pattern) => {
    expect(problems({ ...local, ...patch }).join('\n')).toMatch(pattern);
  });

  it('recognises config errors across module instances', () => {
    const foreign = Object.assign(new Error('x'), { name: 'ConfigError', problems: ['p'] });
    expect(isConfigError(foreign)).toBe(true);
    expect(isConfigError(new Error('ConfigError'))).toBe(false);
    expect(isConfigError(new ConfigError(['p']))).toBe(true);
  });
});
