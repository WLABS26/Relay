import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql, withMaintenanceScope, withTenant } from '@relay/db';
import { isAppError } from '@relay/domain';
import {
  createPost,
  getAsset,
  getPostDetail,
  listPages,
  listPosts,
  mediaUrl,
  scheduleDestination,
  updatePost,
  type AuthenticatedUser,
} from '@relay/services';
import {
  createTenant,
  fetchAll,
  makeContexts,
  meta,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'expected not_found').not.toBeNull();
  expect(isAppError(error) ? error.code : String(error)).toBe('not_found');
}

describe('tenant isolation (M0 gate)', () => {
  let c: Contexts;
  let a: Tenant;
  let b: Tenant;
  let aAsset: string;
  let bAsset: string;
  let bPostId: string;

  beforeAll(async () => {
    c = makeContexts();
    a = await createTenant(c.app);
    b = await createTenant(c.app);
    aAsset = (await uploadFixture(c, a, a.owner, 'portrait-1080x1350.jpg', 'image/jpeg')).assetId;
    bAsset = (await uploadFixture(c, b, b.owner, 'portrait-1080x1350.jpg', 'image/jpeg')).assetId;
    bPostId = (
      await createPost(
        c.app,
        b.owner,
        b.workspaceId,
        {
          pageId: b.pageId,
          title: 'B post',
          caption: 'B only',
          mediaAssetIds: [bAsset],
          destinationIds: [b.destinations.youtube!.pageDestinationId],
        },
        meta,
      )
    ).body.postId;
  });
  afterAll(async () => c.close());

  it('returns zero tenant rows without a tenant context (fail closed)', async () => {
    for (const table of [
      'pages',
      'posts',
      'media_assets',
      'social_accounts',
      'audit_events',
      'workspace_memberships',
      'workspaces',
    ]) {
      const r = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(c.app.db);
      expect(r.rows[0]!.n, table).toBe(0);
    }
  });

  it('scopes reads to the transaction tenant and rejects cross-tenant writes', async () => {
    const seen = await withTenant(c.app.db, { workspaceId: a.workspaceId }, (tx) =>
      tx.selectFrom('posts').select('workspaceId').execute(),
    );
    expect(seen.every((p) => p.workspaceId === a.workspaceId)).toBe(true);
    const bPostFromA = await withTenant(c.app.db, { workspaceId: a.workspaceId }, (tx) =>
      tx.selectFrom('posts').select('id').where('id', '=', bPostId).execute(),
    );
    expect(bPostFromA).toHaveLength(0);
    await expect(
      withTenant(c.app.db, { workspaceId: a.workspaceId }, (tx) =>
        tx
          .insertInto('pages')
          .values({
            id: c.app.ids.next(),
            workspaceId: b.workspaceId,
            name: 'Smuggled',
            timezone: 'UTC',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(c.app.db, { workspaceId: a.workspaceId }, (tx) =>
      tx
        .updateTable('posts')
        .set({ title: 'hijacked' })
        .where('id', '=', bPostId)
        .executeTakeFirst(),
    );
    expect(Number(updated.numUpdatedRows)).toBe(0);
  });

  it('composite foreign keys make cross-tenant references impossible even for the right tenant', async () => {
    // A row in tenant A that points at tenant B's asset fails the (workspace_id, id) FK.
    const aPost = (
      await createPost(
        c.app,
        a.owner,
        a.workspaceId,
        {
          pageId: a.pageId,
          caption: 'A',
          mediaAssetIds: [aAsset],
          destinationIds: [a.destinations.youtube!.pageDestinationId],
        },
        meta,
      )
    ).body;
    await expect(
      withTenant(c.app.db, { workspaceId: a.workspaceId }, (tx) =>
        tx
          .insertInto('postRevisionMedia')
          .values({
            workspaceId: a.workspaceId,
            revisionId: aPost.revisionId,
            position: 5,
            assetId: bAsset,
            assetVersion: 1,
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('never leaks tenant context across pooled connections', async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('relay.workspace_id', $1, true)`, [a.workspaceId]);
      const inTx = await client.query('SELECT count(*)::int AS n FROM pages');
      expect(inTx.rows[0].n).toBeGreaterThan(0);
      await client.query('COMMIT');
      const after = await client.query('SELECT count(*)::int AS n FROM pages');
      expect(after.rows[0].n).toBe(0);
      expect(
        (await client.query(`SELECT current_setting('relay.workspace_id', true) AS v`)).rows[0].v,
      ).toBe('');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('enforces least privilege per database role', async () => {
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
    const worker = new pg.Client({ connectionString: process.env.DATABASE_URL_WORKER });
    await app.connect();
    await worker.connect();
    try {
      const roles = await app.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const owner = await app.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
      );
      expect(owner.rows[0].n).toBe(0);
      await expect(worker.query('SELECT 1 FROM users LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(worker.query('SELECT 1 FROM sessions LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(worker.query('SELECT 1 FROM workspace_memberships LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        app.query('SELECT 1 FROM graphile_worker._private_jobs LIMIT 1'),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query('SELECT 1 FROM provider_sim.remote_posts LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query(`UPDATE audit_events SET actor_label = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query(`DELETE FROM audit_events`)).rejects.toThrow(/permission denied/);
      // Page destinations are immutable in their target.
      await expect(
        app.query(`UPDATE page_destinations SET social_account_id = social_account_id`),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE approvals SET decision = 'approved'`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
      await worker.end();
    }
  });

  it('allows worker maintenance scans to read but never write across tenants', async () => {
    const scanned = await withMaintenanceScope(c.worker.db, (tx) =>
      tx.selectFrom('pages').select('workspaceId').distinct().execute(),
    );
    const ids = scanned.map((r) => r.workspaceId);
    expect(ids).toEqual(expect.arrayContaining([a.workspaceId, b.workspaceId]));
    const updated = await withMaintenanceScope(c.worker.db, (tx) =>
      tx.updateTable('pages').set({ updatedAt: new Date() }).executeTakeFirst(),
    );
    expect(Number(updated.numUpdatedRows)).toBe(0);
    // The app role does not get the maintenance scope at all.
    const appScan = await withMaintenanceScope(c.app.db, (tx) =>
      tx.selectFrom('pages').select('id').execute(),
    );
    expect(appScan).toHaveLength(0);
  });

  it('returns not_found (never forbidden) for cross-tenant IDs through every service', async () => {
    const userA: AuthenticatedUser = a.owner;
    // B's object IDs under A's workspace.
    await expectNotFound(getPostDetail(c.app, userA, a.workspaceId, bPostId));
    await expectNotFound(
      updatePost(
        c.app,
        userA,
        a.workspaceId,
        bPostId,
        { expectedVersion: 1, caption: 'x', mediaAssetIds: [bAsset] },
        meta,
      ),
    );
    await expectNotFound(mediaUrl(c.app, userA, a.workspaceId, bAsset, 'thumbnail'));
    await expectNotFound(
      scheduleDestination(
        c.app,
        userA,
        a.workspaceId,
        c.app.ids.next(),
        { expectedVersion: 1, mode: 'asap' },
        meta,
      ),
    );
    // B's workspace itself: not a member.
    await expectNotFound(listPages(c.app, userA, b.workspaceId));
    await expectNotFound(listPosts(c.app, userA, b.workspaceId, {}));
    await expectNotFound(getPostDetail(c.app, userA, b.workspaceId, bPostId));
    await expectNotFound(mediaUrl(c.app, userA, b.workspaceId, bAsset, 'original'));
  });

  it('mints signed media URLs only for authorised assets and they cannot be re-pointed', async () => {
    const signed = await mediaUrl(c.app, a.owner, a.workspaceId, aAsset, 'original');
    const ok = await fetchAll(signed.url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    // The URL serves exactly the bytes the worker validated, nothing else.
    const { asset } = await getAsset(c.app, a.owner, a.workspaceId, aAsset);
    expect(createHash('sha256').update(ok.bytes).digest('hex')).toBe(asset.sha256);
    // Swap the object key for tenant B's asset: the signature no longer matches.
    const tampered = signed.url.replace(aAsset, bAsset).replace(a.workspaceId, b.workspaceId);
    expect(tampered).not.toBe(signed.url);
    expect((await fetchAll(tampered)).status).toBe(403);
    // The bucket is private: the bare object URL is refused.
    const bare = new URL(signed.url);
    bare.search = '';
    expect((await fetchAll(bare)).status).toBe(403);
  });
});
