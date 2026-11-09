import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import pg from 'pg';
import { Logger, parseCronItems, run, type Runner, type Task, type TaskList } from 'graphile-worker';
import { isConfigError, loadConfig, type RelayConfig } from '@relay/config';
import { loadDotEnv } from '@relay/config/dotenv';
import { checkDatabase, REQUIRED_SCHEMA_VERSION } from '@relay/db';
import {
  advancePublish,
  cleanupExpired,
  closeServiceContext,
  createServiceContext,
  expireUploads,
  parseTaskPayload,
  reconcileDue,
  reconcilePublish,
  refreshMetrics,
  safeError,
  tasksForPool,
  type ServiceContext,
  type TaskName,
} from '@relay/services';
import { processAssetProbe } from '@relay/services/media-pipeline';

/**
 * Relay worker: long-lived Node process running Graphile Worker task pools.
 *
 *   general  publish.advance / publish.reconcile / metrics.refresh / maintenance.* (+ cron)
 *   media    asset.probe (FFmpeg; capped concurrency so encodes cannot starve publishing)
 *
 * RELAY_WORKER_POOLS selects which pools this process runs (both by default locally; one per
 * container in production). Each pool only claims jobs for its own task identifiers.
 */

loadDotEnv();

let config: RelayConfig;
let ctx: ServiceContext;
try {
  config = loadConfig();
  ctx = createServiceContext({ config, role: 'worker' }); // refuses unsupported deployments
} catch (error) {
  if (isConfigError(error)) {
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  throw error;
}

const log = ctx.logger.child({ component: 'worker' });
const workerBase = config.worker.workerId ?? `${hostname()}-${process.pid}`;

const schema = await checkDatabase(ctx.db).catch((error: unknown) => {
  log.fatal({ err: safeError(error) }, 'cannot reach the database');
  process.exit(1);
});
if (!schema.schemaVersion || schema.schemaVersion < REQUIRED_SCHEMA_VERSION) {
  log.fatal({ found: schema.schemaVersion, required: REQUIRED_SCHEMA_VERSION }, 'database schema is older than this build; run `pnpm db:migrate`');
  process.exit(1);
}

function handlers(pool: 'general' | 'media'): TaskList {
  const workerId = `${workerBase}-${pool}`;
  const list: Partial<Record<TaskName, Task>> = {};
  const wrap = (name: TaskName, fn: (payload: unknown, attempt: { number: number; max: number }) => Promise<unknown>): Task =>
    async (payload, helpers) => {
      const started = Date.now();
      try {
        const outcome = await fn(payload, { number: helpers.job.attempts, max: helpers.job.max_attempts });
        log.info({ task: name, jobId: helpers.job.id, ms: Date.now() - started, outcome }, 'task done');
      } catch (error) {
        log.warn({ task: name, jobId: helpers.job.id, attempt: helpers.job.attempts, err: safeError(error) }, 'task failed');
        throw error;
      }
    };
  for (const name of tasksForPool(pool)) {
    switch (name) {
      case 'asset.probe':
        list[name] = wrap(name, (p, attempt) => processAssetProbe(ctx, parseTaskPayload(name, p), attempt));
        break;
      case 'publish.advance':
        list[name] = wrap(name, async (p) => (await advancePublish(ctx, parseTaskPayload(name, p), { workerId })).kind);
        break;
      case 'publish.reconcile':
        list[name] = wrap(name, (p) => reconcilePublish(ctx, parseTaskPayload(name, p), { workerId }));
        break;
      case 'metrics.refresh':
        list[name] = wrap(name, (p) => refreshMetrics(ctx, parseTaskPayload(name, p)));
        break;
      case 'maintenance.reconcile_due':
        list[name] = wrap(name, () => reconcileDue(ctx));
        break;
      case 'maintenance.expire_uploads':
        list[name] = wrap(name, () => expireUploads(ctx));
        break;
      case 'maintenance.cleanup':
        list[name] = wrap(name, () => cleanupExpired(ctx));
        break;
    }
  }
  return list as TaskList;
}

const graphileLogger = new Logger((scope) => (level, message, meta) => {
  const entry = { scope: { label: scope.label, taskIdentifier: scope.taskIdentifier }, ...(meta ? { meta: JSON.stringify(meta).slice(0, 500) } : {}) };
  if (level === 'error') log.error(entry, message);
  else if (level === 'warning') log.warn(entry, message);
  else if (level === 'info') log.debug(entry, message);
});

// Graphile Worker gets its own pool with pg's default type parsers.
const queuePool = new pg.Pool({ connectionString: config.database.workerUrl, max: config.worker.generalConcurrency + config.worker.mediaConcurrency + 4, application_name: 'relay-worker-queue' });
queuePool.on('error', (error) => log.error({ err: safeError(error) }, 'queue pool client error'));
// Graphile holds a long-lived LISTEN client; a dropped connection must surface as a logged
// error (Graphile then reconnects), never as an unhandled 'error' event that kills the worker.
queuePool.on('connect', (client) => client.on('error', (error) => log.error({ err: safeError(error) }, 'queue client error')));

const runners: Runner[] = [];
for (const pool of config.worker.pools) {
  const runner = await run({
    pgPool: queuePool,
    concurrency: pool === 'media' ? config.worker.mediaConcurrency : config.worker.generalConcurrency,
    noHandleSignals: true,
    pollInterval: 1000,
    logger: graphileLogger,
    taskList: handlers(pool),
    ...(pool === 'general'
      ? {
          // Structured cron items (task identifiers contain dots, which crontab syntax rejects).
          parsedCronItems: parseCronItems([
            { task: 'maintenance.reconcile_due', identifier: 'reconcile_due', match: '* * * * *', options: { backfillPeriod: 0, maxAttempts: 1, jobKey: 'cron_reconcile_due', jobKeyMode: 'replace' } },
            { task: 'maintenance.expire_uploads', identifier: 'expire_uploads', match: '*/10 * * * *', options: { backfillPeriod: 0, maxAttempts: 1, jobKey: 'cron_expire_uploads', jobKeyMode: 'replace' } },
            { task: 'maintenance.cleanup', identifier: 'cleanup', match: '17 * * * *', options: { backfillPeriod: 0, maxAttempts: 1, jobKey: 'cron_cleanup', jobKeyMode: 'replace' } },
          ]),
        }
      : {}),
  });
  runners.push(runner);
  log.info({ pool, concurrency: pool === 'media' ? config.worker.mediaConcurrency : config.worker.generalConcurrency, tasks: tasksForPool(pool) }, 'pool started');
}

let shuttingDown = false;
let healthServer: Server | null = null;

/**
 * Probes. Liveness (/healthz) only says the process is running, so a database outage never
 * makes an orchestrator restart every worker; readiness (/readyz) needs the database and is
 * withdrawn while shutting down.
 */
async function handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void json(405, { ok: false });
    if (req.url === '/healthz') return void json(200, { ok: true });
    if (req.url !== '/readyz') return void json(404, { ok: false });
    if (shuttingDown) return void json(503, { ok: false, reason: 'shutting_down' });
    await checkDatabase(ctx.db);
    json(200, { ok: true, pools: config.worker.pools, demoMode: config.demoMode });
  } catch {
    if (!res.headersSent) json(503, { ok: false, reason: 'database_unavailable' });
  }
}

if (config.worker.healthPort > 0) {
  healthServer = createServer((req, res) => void handleProbe(req, res));
  healthServer.listen(config.worker.healthPort, config.worker.healthHost, () =>
    log.info({ host: config.worker.healthHost, port: config.worker.healthPort }, 'health endpoint listening'),
  );
}

log.info({ env: config.env, demoMode: config.demoMode, pools: config.worker.pools, killSwitch: config.ops.publishKillSwitch }, 'relay worker running');

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down: finishing in-flight jobs');
  const timeout = setTimeout(() => {
    log.error('graceful shutdown timed out; exiting');
    process.exit(1);
  }, 60_000);
  timeout.unref();
  await Promise.allSettled(runners.map((r) => r.stop()));
  healthServer?.close();
  await queuePool.end().catch(() => undefined);
  await closeServiceContext(ctx).catch(() => undefined);
  log.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
