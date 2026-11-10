import { describe, expect, it } from 'vitest';
import { evaluateConfig, renderConfigErrorPage } from './config-gate';

const valid = {
  RELAY_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  DATABASE_URL: 'postgres://owner:x@localhost/relay',
  S3_BUCKET: 'relay-unit',
  RELAY_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
};

describe('config gate', () => {
  it('passes a valid configuration', () => {
    expect(evaluateConfig(valid)).toEqual({ ok: true });
  });

  it('collects the problems of an invalid configuration with the resolved environment', () => {
    const gate = evaluateConfig({ ...valid, RELAY_SESSION_SECRET: 'short', RELAY_ENV: 'staging' });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.env).toBe('staging');
    expect(gate.problems.join('\n')).toMatch(/RELAY_SESSION_SECRET/);
  });

  it('treats a missing RELAY_ENV under NODE_ENV=production as production', () => {
    const gate = evaluateConfig({ ...valid, NODE_ENV: 'production' });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.env).toBe('production');
  });

  it('refuses the KMS provider this build does not have, even when the config parses', () => {
    const gate = evaluateConfig({
      ...valid,
      RELAY_ENV: 'staging',
      RELAY_ENCRYPTION_PROVIDER: 'kms',
      RELAY_ENCRYPTION_KEYS: '',
      RELAY_KMS_KEY_ID: 'key',
    });
    expect(gate).toMatchObject({ ok: false, env: 'staging' });
    if (gate.ok) return;
    expect(gate.problems[0]).toMatch(/KMS key provider ships/);
  });

  it('lists problems outside production, escaped, and hides them in production', () => {
    const problems = ['RELAY_WORKER_POOLS: unknown pool "<script>alert(1)</script>"'];
    const staging = renderConfigErrorPage({ ok: false, env: 'staging', problems });
    expect(staging).toContain('&lt;script&gt;');
    expect(staging).not.toContain('<script>');
    expect(staging).toContain('RELAY_WORKER_POOLS');
    const production = renderConfigErrorPage({ ok: false, env: 'production', problems });
    expect(production).not.toContain('RELAY_WORKER_POOLS');
    expect(production).toContain('RELAY_ENV');
    expect(production).toContain('Logs');
  });
});
