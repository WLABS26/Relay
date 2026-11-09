import type { RelayConfig } from '@relay/config';
import { createDatabase, createPool, type Database } from '@relay/db';
import { createIdGenerator, systemClock, type Clock, type IdGenerator } from '@relay/domain';
import { ObjectStorage } from '@relay/media';
import { createAdapterRegistry, type AdapterRegistry } from '@relay/providers';
import type pg from 'pg';
import { createEncryptor, type EnvelopeEncryptor } from './crypto/envelope';
import { createLogger, type Logger } from './logger';
import { createSimulatorStore } from './simulator-store';

/**
 * Everything a service needs, injected explicitly so tests can substitute a clock, ID
 * generator or adapter registry. The web process builds one with the app role; the worker
 * builds one with the worker role.
 */
export interface ServiceContext {
  config: RelayConfig;
  db: Database;
  pool: pg.Pool;
  storage: ObjectStorage;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  registry: AdapterRegistry;
  encryptor: EnvelopeEncryptor;
  role: 'app' | 'worker';
}

/** Per-request metadata carried into audit events and job payloads. */
export interface RequestMeta {
  requestId: string;
  correlationId?: string;
}

export interface CreateContextOptions {
  config: RelayConfig;
  role: 'app' | 'worker';
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  registry?: AdapterRegistry;
  poolMax?: number;
}

/**
 * Startup preflight for web and worker: refuse, with a ConfigError (exit 78), any valid
 * configuration this build cannot honour safely, before a pool or request exists.
 */
export function assertDeploymentSupported(config: RelayConfig): void {
  createEncryptor(config);
}

export function createServiceContext(options: CreateContextOptions): ServiceContext {
  const { config, role } = options;
  // First, so an unsupported deployment fails before any pool is opened.
  const encryptor = createEncryptor(config);
  const logger = options.logger ?? createLogger({ level: config.ops.logLevel, service: `relay-${role}` });
  const pool = createPool({
    connectionString: role === 'app' ? config.database.appUrl : config.database.workerUrl,
    max: options.poolMax ?? config.database.poolMax,
    applicationName: `relay-${role}`,
    onError: (error) => logger.error({ err: { message: error.message } }, 'idle database client error'),
  });
  const db = createDatabase(pool);
  const clock = options.clock ?? systemClock;
  const registry =
    options.registry ??
    createAdapterRegistry({
      demoMode: config.demoMode,
      clock,
      // Only the worker talks to (simulated) providers.
      ...(role === 'worker' ? { simulatorStore: createSimulatorStore(db) } : {}),
    });
  return {
    config,
    db,
    pool,
    storage: new ObjectStorage(config.storage),
    clock,
    ids: options.ids ?? createIdGenerator(clock),
    logger,
    registry,
    encryptor,
    role,
  };
}

export async function closeServiceContext(ctx: ServiceContext): Promise<void> {
  await ctx.db.destroy();
}
