import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { parseConfig } from '@relay/config';
import { loadDotEnv } from '@relay/config/dotenv';
import { recreateDatabase, withDatabase } from '@relay/db/admin';
import { ObjectStorage } from '@relay/media';
import { seedDemo } from '@relay/services/seed';
import { E2E_BUCKET, E2E_DATABASE, E2E_PORT, E2E_WORKER_HEALTH_PORT, REPO_ROOT } from './env';

/**
 * E2E stack launcher (Playwright webServer). Prepares an isolated database and bucket, seeds
 * demo data through the real services, then runs the web app and the worker as children.
 * Playwright kills this process group when the run ends.
 */
loadDotEnv(path.join(REPO_ROOT, '.env'));
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  RELAY_ENV: 'test',
  RELAY_DEMO_MODE: 'true',
  RELAY_PUBLIC_URL: `http://localhost:${E2E_PORT}`,
  RELAY_LOG_LEVEL: 'warn',
  S3_BUCKET: E2E_BUCKET,
  RELAY_WORKER_HEALTH_PORT: String(E2E_WORKER_HEALTH_PORT),
  RELAY_SKIP_DOTENV: 'true',
};
for (const key of ['DATABASE_URL_MIGRATOR', 'DATABASE_URL_APP', 'DATABASE_URL_WORKER']) {
  const url = env[key];
  if (!url) throw new Error(`${key} is not set (copy .env.example to .env)`);
  env[key] = withDatabase(url, E2E_DATABASE);
}

const log = (m: string) => console.log(`[e2e-stack] ${m}`);
await recreateDatabase({
  migratorUrl: env.DATABASE_URL_MIGRATOR!,
  database: E2E_DATABASE,
  logger: { info: () => {}, warn: console.warn },
});
log(`database ${E2E_DATABASE} recreated`);
const config = parseConfig(env);
await new ObjectStorage(config.storage).ensureBucket([
  `http://localhost:${E2E_PORT}`,
  `http://127.0.0.1:${E2E_PORT}`,
]);
log(`bucket ${E2E_BUCKET} ready`);
await seedDemo(config, { log: (m) => log(`seed: ${m}`) });

const children: ChildProcess[] = [];
const start = (name: string, command: string, args: string[], cwd: string) => {
  const child = spawn(command, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    log(`${name} exited (${code ?? signal})`);
    for (const c of children) if (c !== child) c.kill('SIGTERM');
    process.exit(code ?? 1);
  });
  children.push(child);
};
start('worker', 'pnpm', ['exec', 'tsx', 'src/main.ts'], path.join(REPO_ROOT, 'apps/worker'));
const dev = process.env.E2E_DEV === '1';
start(
  'web',
  'pnpm',
  ['exec', 'next', dev ? 'dev' : 'start', '--port', String(E2E_PORT)],
  path.join(REPO_ROOT, 'apps/web'),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    for (const c of children) c.kill('SIGTERM');
    process.exit(0);
  });
}
