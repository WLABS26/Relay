import { z } from 'zod';
import { enqueueJob, type EnqueueOptions, type Executor } from '@relay/db';

/**
 * Worker task catalogue. Payloads are minimal ID/version pointers validated on both sides;
 * handlers reload authoritative state from Postgres and treat every payload as a hint that
 * may be stale, duplicated or out of order.
 */

const id = z.uuid();

export const TASKS = {
  'asset.probe': {
    pool: 'media',
    schema: z.object({
      workspaceId: id,
      assetId: id,
      uploadSessionId: id,
      correlationId: z.string().max(100).optional(),
    }),
    maxAttempts: 3,
  },
  'publish.advance': {
    pool: 'general',
    schema: z.object({
      workspaceId: id,
      postDestinationId: id,
      intentId: id,
      intentVersion: z.number().int().positive(),
      correlationId: z.string().max(100).optional(),
    }),
    // Retries are driven by Relay's own ledger; the queue only re-delivers crashed attempts.
    maxAttempts: 5,
  },
  'publish.reconcile': {
    pool: 'general',
    schema: z.object({
      workspaceId: id,
      postDestinationId: id,
      intentId: id,
      correlationId: z.string().max(100).optional(),
    }),
    maxAttempts: 5,
  },
  'metrics.refresh': {
    pool: 'general',
    schema: z.object({
      workspaceId: id,
      externalPublicationId: id,
      ageBucket: z.enum(['24h', '72h', '7d', '30d']).nullable(),
    }),
    maxAttempts: 5,
  },
  'maintenance.reconcile_due': {
    pool: 'general',
    schema: z.object({}).passthrough(),
    maxAttempts: 1,
  },
  'maintenance.expire_uploads': {
    pool: 'general',
    schema: z.object({}).passthrough(),
    maxAttempts: 1,
  },
  'maintenance.cleanup': { pool: 'general', schema: z.object({}).passthrough(), maxAttempts: 1 },
} as const;

export type TaskName = keyof typeof TASKS;
export type TaskPayload<T extends TaskName> = z.infer<(typeof TASKS)[T]['schema']>;

export const TASK_NAMES = Object.keys(TASKS) as TaskName[];

export function tasksForPool(pool: 'general' | 'media'): TaskName[] {
  return TASK_NAMES.filter((name) => TASKS[name].pool === pool);
}

/** Enqueue on the caller's transaction (transactional outbox semantics). */
export async function enqueue<T extends TaskName>(
  executor: Executor,
  task: T,
  payload: TaskPayload<T>,
  options: EnqueueOptions = {},
): Promise<string> {
  const parsed = TASKS[task].schema.parse(payload) as Record<string, unknown>;
  return enqueueJob(executor, task, parsed, { maxAttempts: TASKS[task].maxAttempts, ...options });
}

export function parseTaskPayload<T extends TaskName>(task: T, payload: unknown): TaskPayload<T> {
  return TASKS[task].schema.parse(payload) as TaskPayload<T>;
}
