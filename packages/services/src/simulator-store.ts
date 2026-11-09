import { sql, type Database } from '@relay/db';
import type { DestinationProviderId, Visibility } from '@relay/domain';
import type { SimulatorRemotePost, SimulatorStore } from '@relay/providers';

/**
 * SimulatorStore over the provider_sim schema (worker role only). Each call is its own
 * statement on the pool — deliberately outside Relay's business transactions, exactly as a
 * remote platform call would be.
 */

type Row = {
  id: string;
  provider: string;
  accountRef: string;
  operationId: string;
  externalId: string;
  containerId: string;
  status: string;
  visibility: string;
  format: string;
  captionSha256: string;
  mediaCount: number;
  processingPollsRemaining: number;
  createdAt: Date;
  publishedAt: Date | null;
};

function toPost(row: Row): SimulatorRemotePost {
  return {
    ...row,
    provider: row.provider as DestinationProviderId,
    status: row.status as SimulatorRemotePost['status'],
    visibility: row.visibility as Visibility,
  };
}

export function createSimulatorStore(db: Database): SimulatorStore {
  const table = 'providerSim.remotePosts' as const;
  return {
    async findByOperation(operationId) {
      const row = await db
        .selectFrom(table)
        .selectAll()
        .where('operationId', '=', operationId)
        .executeTakeFirst();
      return row ? toPost(row as Row) : null;
    },
    async upsertStaged(post) {
      await db
        .insertInto(table)
        .values({ ...post })
        .onConflict((oc) => oc.column('operationId').doNothing())
        .execute();
      const row = await db
        .selectFrom(table)
        .selectAll()
        .where('operationId', '=', post.operationId)
        .executeTakeFirstOrThrow();
      return toPost(row as Row);
    },
    async update(operationId, patch) {
      if (Object.keys(patch).length === 0) return;
      await db.updateTable(table).set(patch).where('operationId', '=', operationId).execute();
    },
    async bumpCounter(operationId, phase) {
      const result = await sql<{ calls: number }>`
        INSERT INTO provider_sim.call_counters (operation_id, phase, calls) VALUES (${operationId}, ${phase}, 1)
        ON CONFLICT (operation_id, phase) DO UPDATE SET calls = provider_sim.call_counters.calls + 1
        RETURNING calls`.execute(db);
      return result.rows[0]!.calls;
    },
    async listRecent(provider, accountRef, limit) {
      const rows = await db
        .selectFrom(table)
        .selectAll()
        .where('provider', '=', provider)
        .where('accountRef', '=', accountRef)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toPost(r as Row));
    },
  };
}
