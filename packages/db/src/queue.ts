import { sql } from 'kysely';
import type { Executor } from './client';

/**
 * Transactional enqueue. Jobs are added (via relay_enqueue_job → graphile_worker.add_job) on the SAME connection
 * and transaction as the business write, so a job exists if and only if the write committed.
 * Payloads are minimal ID/version pointers; workers reload authoritative state from Postgres.
 */
export interface EnqueueOptions {
  runAt?: Date;
  /** Deduplicate/replace pending jobs with the same key. */
  jobKey?: string;
  jobKeyMode?: 'replace' | 'preserve_run_at' | 'unsafe_dedupe';
  maxAttempts?: number;
  queueName?: string;
  priority?: number;
}

export async function enqueueJob(
  executor: Executor,
  task: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string> {
  const result = await sql<{ id: string }>`
    SELECT relay_enqueue_job(
      ${task},
      ${JSON.stringify(payload)}::json,
      ${options.queueName ?? null}::text,
      ${options.runAt ? options.runAt.toISOString() : null}::timestamptz,
      ${options.maxAttempts ?? null}::int,
      ${options.jobKey ?? null}::text,
      ${options.priority ?? null}::int,
      ${options.jobKeyMode ?? 'replace'}::text
    )::text AS id`.execute(executor);
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Failed to enqueue ${task}`);
  return id;
}
