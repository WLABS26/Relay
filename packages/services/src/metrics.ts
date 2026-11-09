import { sql, withTenant } from '@relay/db';
import { AGE_BUCKETS, observationKey } from '@relay/domain';
import { toConnectedAccount } from './connections';
import type { ServiceContext } from './context';
import type { TaskPayload } from './tasks';

/**
 * metrics.refresh — fetch post metrics for a confirmed publication at a given observation
 * age and upsert them idempotently on (publication, definition, observation key). Revised
 * provider values update in place with a revision counter; repeated cumulative snapshots are
 * never summed. Unavailable metrics are stored with their availability code, not as zero.
 */
export async function refreshMetrics(
  ctx: ServiceContext,
  payload: TaskPayload<'metrics.refresh'>,
): Promise<string> {
  const { workspaceId, externalPublicationId, ageBucket } = payload;
  const loaded = await withTenant(ctx.db, { workspaceId }, async (tx) => {
    const pub = await tx
      .selectFrom('externalPublications')
      .selectAll()
      .where('id', '=', externalPublicationId)
      .executeTakeFirst();
    if (!pub || pub.status !== 'live') return null;
    const account = await tx
      .selectFrom('socialAccounts')
      .selectAll()
      .where('id', '=', pub.socialAccountId)
      .executeTakeFirstOrThrow();
    const runId = ctx.ids.next();
    await tx
      .insertInto('metricSyncRuns')
      .values({
        id: runId,
        workspaceId,
        externalPublicationId,
        ageBucket,
        status: 'running',
        provenance: account.connectionMode === 'simulated' ? 'simulator' : 'provider_api',
      })
      .execute();
    return { pub, account, runId };
  });
  if (!loaded) return 'skipped';
  const { pub, account, runId } = loaded;
  const adapter = ctx.registry.metrics(
    pub.provider as 'youtube',
    pub.connectionMode as 'simulated',
  );
  const now = ctx.clock.now();
  if (!adapter) {
    await withTenant(ctx.db, { workspaceId }, (tx) =>
      tx
        .updateTable('metricSyncRuns')
        .set({ status: 'failed', errorCode: 'adapter_unavailable', finishedAt: now })
        .where('id', '=', runId)
        .execute(),
    );
    return 'no_adapter';
  }
  // Snapshot the reading at the bucket's nominal age when catching up late.
  const bucketHours = AGE_BUCKETS.find((b) => b.key === ageBucket)?.hours;
  const at = bucketHours
    ? new Date(Math.min(now.getTime(), pub.publishedAt.getTime() + bucketHours * 3600_000))
    : now;
  let readings;
  try {
    readings = await adapter.fetchPostMetrics({
      account: toConnectedAccount(account),
      publication: {
        externalId: pub.externalId,
        publishedAt: pub.publishedAt.toISOString(),
        format: pub.format as 'video',
      },
      ageBucket,
      now: at,
    });
  } catch (error) {
    await withTenant(ctx.db, { workspaceId }, (tx) =>
      tx
        .updateTable('metricSyncRuns')
        .set({ status: 'failed', errorCode: 'fetch_failed', finishedAt: ctx.clock.now() })
        .where('id', '=', runId)
        .execute(),
    );
    throw error;
  }
  const definitionProvider = pub.connectionMode === 'simulated' ? 'simulator' : pub.provider;
  await withTenant(ctx.db, { workspaceId }, async (tx) => {
    const definitions = await tx
      .selectFrom('metricDefinitions')
      .select(['id', 'metricKey', 'definitionVersion'])
      .where('provider', '=', definitionProvider)
      .execute();
    const key = observationKey({ ageBucket });
    for (const r of readings) {
      const def = definitions.find(
        (d) => d.metricKey === r.metricKey && d.definitionVersion === r.definitionVersion,
      );
      if (!def) continue; // unknown definitions are never stored as if comparable
      await sql`
        INSERT INTO metric_observations (id, workspace_id, external_publication_id, metric_definition_id, observation_key, age_bucket,
                                         observed_at, published_at, value, availability, provenance, source_policy, source_endpoint, sync_run_id)
        VALUES (${ctx.ids.next()}, ${workspaceId}, ${externalPublicationId}, ${def.id}, ${key}, ${ageBucket}, ${r.observedAt}, ${pub.publishedAt},
                ${r.value === null ? null : String(r.value)}, ${r.availability}, ${pub.connectionMode === 'simulated' ? 'simulator' : 'provider_api'},
                ${adapter.sourcePolicy}, ${pub.connectionMode === 'simulated' ? 'simulator:fetchPostMetrics' : null}, ${runId})
        ON CONFLICT (workspace_id, external_publication_id, metric_definition_id, observation_key) DO UPDATE SET
          value = EXCLUDED.value,
          availability = EXCLUDED.availability,
          observed_at = EXCLUDED.observed_at,
          sync_run_id = EXCLUDED.sync_run_id,
          revision = metric_observations.revision + CASE
            WHEN metric_observations.value IS DISTINCT FROM EXCLUDED.value OR metric_observations.availability <> EXCLUDED.availability THEN 1 ELSE 0 END,
          revised_at = CASE
            WHEN metric_observations.value IS DISTINCT FROM EXCLUDED.value OR metric_observations.availability <> EXCLUDED.availability THEN now()
            ELSE metric_observations.revised_at END`.execute(tx);
    }
    await tx
      .updateTable('metricSyncRuns')
      .set({ status: 'succeeded', finishedAt: ctx.clock.now() })
      .where('id', '=', runId)
      .execute();
  });
  return 'ok';
}
