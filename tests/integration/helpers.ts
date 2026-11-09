import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig, type RelayConfig } from '@relay/config';
import { REPO_ROOT } from '@relay/config/dotenv';
import { withAuthBootstrap, withTenant } from '@relay/db';
import { ManualClock, type Clock, type DestinationState } from '@relay/domain';
import type { SimulatorProfile } from '@relay/providers';
import {
  addPageDestination,
  advancePublish,
  completeUpload,
  createDemoConnection,
  createPage,
  createServiceContext,
  createWorkspace,
  reconcilePublish,
  signUploadParts,
  startUpload,
  type AuthenticatedUser,
  type ServiceContext,
} from '@relay/services';
import { processAssetProbe } from '@relay/services/media-pipeline';

export const meta = { requestId: 'test-request' };
let counter = 0;
export const unique = (prefix: string) =>
  `${prefix}-${process.pid}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function testConfig(overrides: Record<string, string> = {}): RelayConfig {
  return parseConfig({ ...process.env, ...overrides });
}

export interface Contexts {
  app: ServiceContext;
  worker: ServiceContext;
  clock: Clock;
  close(): Promise<void>;
}

export function makeContexts(options: { clock?: Clock; config?: RelayConfig } = {}): Contexts {
  const config = options.config ?? testConfig();
  const clock = options.clock ?? { now: () => new Date() };
  const app = createServiceContext({ config, role: 'app', clock, poolMax: 4 });
  const worker = createServiceContext({ config, role: 'worker', clock, poolMax: 4 });
  return {
    app,
    worker,
    clock,
    close: async () => {
      await app.db.destroy();
      await worker.db.destroy();
    },
  };
}

export async function createUser(
  ctx: ServiceContext,
  input: { name: string; email?: string; isDemo?: boolean },
): Promise<AuthenticatedUser> {
  const id = ctx.ids.next();
  const email = (
    input.email ?? `${unique(input.name.toLowerCase().replace(/\W+/g, ''))}@example.test`
  ).toLowerCase();
  await withAuthBootstrap(ctx.db, (tx) =>
    tx
      .insertInto('users')
      .values({
        id,
        email,
        emailNormalized: email,
        displayName: input.name,
        isDemo: input.isDemo ?? true,
      })
      .execute(),
  );
  return { userId: id, email, displayName: input.name, isDemo: input.isDemo ?? true };
}

export interface Tenant {
  owner: AuthenticatedUser;
  workspaceId: string;
  slug: string;
  pageId: string;
  destinations: Record<string, { pageDestinationId: string; socialAccountId: string }>;
}

export async function createTenant(
  ctx: ServiceContext,
  options: {
    zone?: string;
    accounts?: Array<{
      key: string;
      provider: 'youtube' | 'instagram' | 'facebook_page' | 'tiktok';
      profile?: SimulatorProfile;
    }>;
  } = {},
): Promise<Tenant> {
  const owner = await createUser(ctx, { name: 'Owner' });
  const slug = unique('ws')
    .slice(0, 40)
    .replace(/[^a-z0-9-]/g, '');
  const ws = await createWorkspace(
    ctx,
    owner,
    { name: 'Test workspace', slug, timezone: options.zone ?? 'Europe/Berlin' },
    meta,
    { isDemo: true },
  );
  const page = await createPage(
    ctx,
    owner,
    ws.id,
    { name: 'Test page', timezone: options.zone ?? 'Europe/Berlin' },
    meta,
  );
  const destinations: Tenant['destinations'] = {};
  for (const a of options.accounts ?? [{ key: 'youtube', provider: 'youtube' as const }]) {
    const account = await createDemoConnection(
      ctx,
      owner,
      ws.id,
      { provider: a.provider, displayName: `Demo ${a.key}`, profile: a.profile ?? 'reliable' },
      meta,
    );
    const dest = await addPageDestination(
      ctx,
      owner,
      ws.id,
      page.id,
      { socialAccountId: account.id },
      meta,
    );
    destinations[a.key] = { pageDestinationId: dest.id, socialAccountId: account.id };
  }
  return { owner, workspaceId: ws.id, slug, pageId: page.id, destinations };
}

export function fixturePath(name: string): string {
  return path.join(REPO_ROOT, 'fixtures/media', name);
}

/**
 * fetch() that always reads the whole body. An unread body leaves undici's parser paused on
 * the socket, and a server-side close then trips an internal assertion after the test ends.
 */
export async function fetchAll(input: string | URL, init?: RequestInit) {
  const res = await fetch(input, init);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, headers: res.headers, bytes };
}

/** Upload a fixture the way a browser would (presigned PUT / parts), then run validation. */
export async function uploadFixture(
  c: Contexts,
  tenant: Pick<Tenant, 'workspaceId' | 'pageId'>,
  user: AuthenticatedUser,
  name: string,
  mime: string,
  options: { process?: boolean } = {},
) {
  const bytes = await readFile(fixturePath(name));
  const start = await startUpload(
    c.app,
    user,
    tenant.workspaceId,
    {
      pageId: tenant.pageId,
      filename: name,
      mimeType: mime,
      sizeBytes: bytes.length,
      declaration: { confirmed: true, statementVersion: 'first-party-v1' },
    },
    meta,
  );
  const body = start.body;
  let parts: Array<{ partNumber: number; etag: string }> | undefined;
  if (body.single) {
    const res = await fetchAll(body.single.url, {
      method: 'PUT',
      body: bytes,
      headers: body.single.headers,
    });
    if (!res.ok)
      throw new Error(`presigned PUT failed: ${res.status} ${res.bytes.toString('utf8')}`);
  } else {
    const { partSize, partCount } = body.multipart!;
    const signed = await signUploadParts(c.app, user, tenant.workspaceId, body.uploadId, {
      partNumbers: Array.from({ length: partCount }, (_, i) => i + 1),
    });
    parts = [];
    for (const p of signed.parts) {
      const chunk = bytes.subarray((p.partNumber - 1) * partSize, p.partNumber * partSize);
      const res = await fetchAll(p.url, { method: 'PUT', body: chunk });
      if (!res.ok) throw new Error(`part ${p.partNumber} failed: ${res.status}`);
      parts.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' });
    }
  }
  await completeUpload(
    c.app,
    user,
    tenant.workspaceId,
    body.uploadId,
    parts ? { parts } : {},
    meta,
  );
  const outcome =
    options.process === false
      ? null
      : await processAssetProbe(
          c.worker,
          {
            workspaceId: tenant.workspaceId,
            assetId: body.assetId,
            uploadSessionId: body.uploadId,
          },
          { number: 1, max: 3 },
        );
  return { assetId: body.assetId, uploadId: body.uploadId, outcome, strategy: body.strategy };
}

export async function destinationState(
  ctx: ServiceContext,
  workspaceId: string,
  postDestinationId: string,
) {
  return withTenant(ctx.db, { workspaceId }, (tx) =>
    tx
      .selectFrom('postDestinations')
      .selectAll()
      .where('id', '=', postDestinationId)
      .executeTakeFirstOrThrow(),
  );
}

/**
 * Drive the publish workflow the way the worker would, deterministically: call advance (or
 * reconcile) until the destination settles, moving the manual clock forward whenever the
 * workflow asks to wait. Returns the final state and the sequence of outcomes.
 */
export async function drivePublishing(
  c: Contexts,
  workspaceId: string,
  postDestinationId: string,
  options: { maxSteps?: number; workerId?: string } = {},
): Promise<{ state: DestinationState; steps: string[] }> {
  const steps: string[] = [];
  const clock = c.clock as ManualClock;
  for (let i = 0; i < (options.maxSteps ?? 30); i++) {
    const pd = await destinationState(c.worker, workspaceId, postDestinationId);
    const state = pd.state as DestinationState;
    if (!pd.activeIntentId) return { state, steps };
    const intent = await withTenant(c.worker.db, { workspaceId }, (tx) =>
      tx
        .selectFrom('publishIntents')
        .select(['id', 'intentVersion', 'plannedAt'])
        .where('id', '=', pd.activeIntentId!)
        .executeTakeFirstOrThrow(),
    );
    if (state === 'needs_reconciliation') {
      if (pd.stateReason === 'operator_review_required') return { state, steps };
      const r = await reconcilePublish(
        c.worker,
        { workspaceId, postDestinationId, intentId: intent.id },
        { workerId: options.workerId ?? 'test-worker' },
      );
      steps.push(`reconcile:${r}`);
      if (r === 'indeterminate') return { state: 'needs_reconciliation', steps };
      continue;
    }
    if (!['scheduled', 'preparing', 'dispatching', 'processing'].includes(state))
      return { state, steps };
    const outcome = await advancePublish(
      c.worker,
      { workspaceId, postDestinationId, intentId: intent.id, intentVersion: intent.intentVersion },
      { workerId: options.workerId ?? 'test-worker' },
    );
    steps.push(outcome.kind === 'step' ? `${outcome.phase}:${outcome.result}` : outcome.kind);
    if (outcome.kind === 'deferred' && clock instanceof ManualClock)
      clock.set(new Date(Date.parse(outcome.until) + 1));
    else if (
      outcome.kind === 'step' &&
      ['waiting', 'rate_limited', 'retryable'].includes(outcome.result) &&
      clock instanceof ManualClock
    )
      clock.advance(5 * 60_000);
    else if (outcome.kind === 'blocked' || outcome.kind === 'stale' || outcome.kind === 'held') {
      const after = await destinationState(c.worker, workspaceId, postDestinationId);
      return { state: after.state as DestinationState, steps };
    }
  }
  const final = await destinationState(c.worker, workspaceId, postDestinationId);
  return { state: final.state as DestinationState, steps };
}

/** Create a post on the given destinations, submit it and approve every destination. */
export async function approvedPost(
  c: Contexts,
  tenant: Tenant,
  options: {
    destinationKeys: string[];
    assetIds: string[];
    title?: string;
    caption?: string;
    user?: AuthenticatedUser;
  },
) {
  const { createPost, submitPost, getPostDetail, decideApprovals } =
    await import('@relay/services');
  const user = options.user ?? tenant.owner;
  const created = await createPost(
    c.app,
    user,
    tenant.workspaceId,
    {
      pageId: tenant.pageId,
      title: options.title ?? 'Sample post',
      caption: options.caption ?? 'Sample caption',
      mediaAssetIds: options.assetIds,
      destinationIds: options.destinationKeys.map((k) => tenant.destinations[k]!.pageDestinationId),
    },
    meta,
  );
  const postId = created.body.postId;
  const submitted = await submitPost(c.app, user, tenant.workspaceId, postId, {}, meta);
  const failed = submitted.outcomes.filter((o) => !o.ok);
  if (failed.length) throw new Error(`submit failed: ${JSON.stringify(failed)}`);
  const detail = await getPostDetail(c.app, user, tenant.workspaceId, postId);
  const decided = await decideApprovals(
    c.app,
    user,
    tenant.workspaceId,
    postId,
    {
      decisions: detail.destinations.map((d) => ({
        postDestinationId: d.id,
        decision: 'approve' as const,
        revisionId: detail.revision.id,
        intentHash: d.intentHash,
      })),
    },
    meta,
  );
  const rejected = decided.outcomes.filter((o) => !o.ok);
  if (rejected.length) throw new Error(`approval failed: ${JSON.stringify(rejected)}`);
  const fresh = await getPostDetail(c.app, user, tenant.workspaceId, postId);
  const byKey: Record<string, { id: string; version: number }> = {};
  for (const key of options.destinationKeys) {
    const d = fresh.destinations.find(
      (x) => x.pageDestinationId === tenant.destinations[key]!.pageDestinationId,
    )!;
    byKey[key] = { id: d.id, version: d.version };
  }
  return { postId, revisionId: fresh.revision.id, destinations: byKey };
}

export async function expectAppError(promise: Promise<unknown>, code: string) {
  const { isAppError } = await import('@relay/domain');
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!error) throw new Error(`expected ${code}, but the call succeeded`);
  if (!isAppError(error)) throw error;
  if (error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}
