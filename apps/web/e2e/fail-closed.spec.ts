import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { REPO_ROOT } from './env';

/** Production configuration with demo auth must refuse to start (web and worker). */
function run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env, RELAY_SKIP_DOTENV: 'true' } as NodeJS.ProcessEnv });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const productionWithDemo = {
  NODE_ENV: 'production',
  RELAY_ENV: 'production',
  RELAY_DEMO_MODE: 'true',
  RELAY_PUBLIC_URL: 'https://relay.example',
  RELAY_SESSION_SECRET: 'relay-dev-session-secret-change-me-0123456789abcdef',
  DATABASE_URL_APP: 'postgres://relay_app:relay-dev-app@127.0.0.1:5432/relay',
  DATABASE_URL_WORKER: 'postgres://relay_worker:relay-dev-worker@127.0.0.1:5432/relay',
  S3_BUCKET: 'relay-prod',
  RELAY_ENCRYPTION_PROVIDER: 'local',
  RELAY_ENCRYPTION_KEYS: 'dev-2026-11:ZGV2LWtleS1kby1ub3QtdXNlLWluLXByb2R1Y3Rpb24=',
  PORT: '3199',
};

/**
 * A production configuration that passes every validation rule (https, non-default secrets,
 * OIDC, KMS). This build has no KMS key provider yet (M3), so it must still refuse to start
 * rather than run and store secrets under a local key. Placeholders only; nothing is contacted.
 */
const validProductionWithoutKmsSupport = {
  NODE_ENV: 'production',
  RELAY_ENV: 'production',
  RELAY_DEMO_MODE: 'false',
  RELAY_PUBLIC_URL: 'https://relay.example',
  RELAY_SESSION_SECRET: 'e2e-placeholder-session-secret-not-a-real-one-7f3a9c',
  DATABASE_URL_APP: 'postgres://relay_app:e2e-placeholder@127.0.0.1:5432/relay',
  DATABASE_URL_WORKER: 'postgres://relay_worker:e2e-placeholder@127.0.0.1:5432/relay',
  S3_BUCKET: 'relay-prod',
  RELAY_ENCRYPTION_PROVIDER: 'kms',
  RELAY_ENCRYPTION_KEYS: '',
  RELAY_KMS_KEY_ID: 'arn:aws:kms:eu-central-1:000000000000:key/placeholder',
  RELAY_OIDC_ISSUER: 'https://login.relay.example',
  RELAY_OIDC_CLIENT_ID: 'placeholder-client',
  RELAY_OIDC_CLIENT_SECRET: 'placeholder-secret',
  // Blank anything the parent process may carry from the developer .env.
  DATABASE_URL_MIGRATOR: '',
  S3_ENDPOINT: '',
  S3_PUBLIC_ENDPOINT: '',
  S3_ACCESS_KEY_ID: '',
  S3_SECRET_ACCESS_KEY: '',
  PORT: '3199',
};

test.describe('fail closed in production', () => {
  test('the web server refuses a valid production config until the KMS provider exists', async () => {
    const { code, output } = await run('pnpm', ['exec', 'next', 'start', '--port', '3199'], path.join(REPO_ROOT, 'apps/web'), validProductionWithoutKmsSupport);
    expect(code).toBe(78);
    expect(output).toContain('the KMS key provider ships with the provider-credential milestone (M3)');
  });

  test('the worker refuses a valid production config until the KMS provider exists', async () => {
    const { code, output } = await run('pnpm', ['exec', 'tsx', 'src/main.ts'], path.join(REPO_ROOT, 'apps/worker'), validProductionWithoutKmsSupport);
    expect(code).toBe(78);
    expect(output).toContain('the KMS key provider ships with the provider-credential milestone (M3)');
  });

  test('the web server refuses to start with demo auth and default secrets', async () => {
    const { code, output } = await run('pnpm', ['exec', 'next', 'start', '--port', '3199'], path.join(REPO_ROOT, 'apps/web'), productionWithDemo);
    expect(code).toBe(78);
    expect(output).toContain('RELAY_DEMO_MODE must be false in production');
    expect(output).toContain('RELAY_SESSION_SECRET is a known development default');
    expect(output).toContain('RELAY_ENCRYPTION_PROVIDER must be "kms" in production');
  });

  test('the worker refuses to start with demo auth and default secrets', async () => {
    const { code, output } = await run('pnpm', ['exec', 'tsx', 'src/main.ts'], path.join(REPO_ROOT, 'apps/worker'), productionWithDemo);
    expect(code).toBe(78);
    expect(output).toContain('RELAY_DEMO_MODE must be false in production');
  });
});
