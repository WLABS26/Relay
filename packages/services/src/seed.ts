import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type RelayConfig } from '@relay/config';
import { REPO_ROOT } from '@relay/config/dotenv';
import { withAuthBootstrap, withTenant, withUser } from '@relay/db';
import { AGE_BUCKETS, ManualClock, type DestinationState } from '@relay/domain';
import { generateFixtures } from '@relay/media/fixtures';
import type { SimulatorProfile } from '@relay/providers';
import type { AuthenticatedUser } from './access';
import { decideApprovals } from './approvals';
import { addPageDestination, createDemoConnection } from './connections';
import { createServiceContext, type ServiceContext } from './context';
import { acceptInvitation, inviteMember } from './members';
import { processAssetProbe } from './media-pipeline';
import { refreshMetrics } from './metrics';
import { createPage } from './pages';
import { createPost, getPostDetail } from './posts';
import { advancePublish, reconcilePublish } from './publishing';
import { recommendSlotsFor, scheduleDestination } from './scheduling';
import { submitPost } from './approvals';
import { completeUpload, startUpload } from './uploads';
import { createWorkspace } from './workspaces';

/**
 * Demo seed. Everything goes through the real services — uploads are validated by the media
 * pipeline, publications are produced by the real worker workflow against the simulator, and
 * historical results come from running that workflow under a clock set in the past. All
 * content is sample data (flagged), all connections are simulated, and no person or brand is
 * real. Seeds Europe/Berlin as the demo zone.
 */

const meta = { requestId: 'seed' };

interface SeedContexts {
  app: ServiceContext;
  worker: ServiceContext;
  clock: ManualClock;
  fixturesDir: string;
}

const DEMO_USERS = [
  { key: 'mara', name: 'Mara Lindqvist', email: 'mara@fernhill.example' },
  { key: 'theo', name: 'Theo Brandt', email: 'theo@fernhill.example' },
  { key: 'priya', name: 'Priya Raman', email: 'priya@fernhill.example' },
  { key: 'eli', name: 'Eli Novak', email: 'eli@fernhill.example' },
  { key: 'vic', name: 'Vic Osei', email: 'vic@fernhill.example' },
  { key: 'gus', name: 'Gus Ferreira', email: 'gus@kestrel.example' },
  { key: 'kim', name: 'Kim Sato', email: 'kim@kestrel.example' },
] as const;

async function ensureUser(
  ctx: ServiceContext,
  u: { name: string; email: string },
): Promise<AuthenticatedUser> {
  return withAuthBootstrap(ctx.db, async (tx) => {
    const existing = await tx
      .selectFrom('users')
      .select(['id'])
      .where('emailNormalized', '=', u.email)
      .executeTakeFirst();
    const id = existing?.id ?? ctx.ids.next();
    if (!existing)
      await tx
        .insertInto('users')
        .values({ id, email: u.email, emailNormalized: u.email, displayName: u.name, isDemo: true })
        .execute();
    return { userId: id, email: u.email, displayName: u.name, isDemo: true };
  });
}

async function upload(
  c: SeedContexts,
  user: AuthenticatedUser,
  workspaceId: string,
  pageId: string,
  name: string,
  mime: string,
): Promise<string> {
  const bytes = await readFile(path.join(c.fixturesDir, name));
  const start = await startUpload(
    c.app,
    user,
    workspaceId,
    {
      pageId,
      filename: name.replace(/^(\w)/, (m) => m.toUpperCase()),
      mimeType: mime,
      sizeBytes: bytes.length,
      declaration: { confirmed: true, statementVersion: 'first-party-v1' },
    },
    meta,
  );
  const body = start.body;
  let parts: Array<{ partNumber: number; etag: string }> | undefined;
  if (body.single) {
    const res = await fetch(body.single.url, {
      method: 'PUT',
      body: bytes,
      headers: body.single.headers,
    });
    await res.arrayBuffer(); // always drain, so the socket is released cleanly
    if (!res.ok)
      throw new Error(
        `seed upload failed (${res.status}). Is object storage running and the bucket provisioned?`,
      );
  } else {
    throw new Error('seed fixtures are expected to fit a single PUT');
  }
  await completeUpload(c.app, user, workspaceId, body.uploadId, parts ? { parts } : {}, meta);
  const outcome = await processAssetProbe(
    c.worker,
    { workspaceId, assetId: body.assetId, uploadSessionId: body.uploadId },
    { number: 1, max: 1 },
  );
  if (outcome !== 'ready') throw new Error(`seed media ${name} was ${outcome}`);
  return body.assetId;
}

async function approvedPost(
  c: SeedContexts,
  user: AuthenticatedUser,
  workspaceId: string,
  input: {
    pageId: string;
    title: string;
    caption: string;
    assetIds: string[];
    destinationIds: string[];
    approve?: boolean;
    submit?: boolean;
  },
) {
  const created = await createPost(
    c.app,
    user,
    workspaceId,
    {
      pageId: input.pageId,
      title: input.title,
      caption: input.caption,
      mediaAssetIds: input.assetIds,
      destinationIds: input.destinationIds,
    },
    meta,
    { isSample: true },
  );
  const postId = created.body.postId;
  if (input.submit === false)
    return { postId, destinations: [] as Array<{ id: string; version: number; label: string }> };
  await submitPost(c.app, user, workspaceId, postId, {}, meta);
  if (input.approve !== false) {
    const detail = await getPostDetail(c.app, user, workspaceId, postId);
    await decideApprovals(
      c.app,
      user,
      workspaceId,
      postId,
      {
        decisions: detail.destinations
          .filter((d) => d.state === 'needs_review')
          .map((d) => ({
            postDestinationId: d.id,
            decision: 'approve' as const,
            revisionId: detail.revision.id,
            intentHash: d.intentHash,
          })),
      },
      meta,
    );
  }
  const fresh = await getPostDetail(c.app, user, workspaceId, postId);
  return {
    postId,
    destinations: fresh.destinations.map((d) => ({ id: d.id, version: d.version, label: d.label })),
  };
}

/** Run the worker workflow synchronously until the destination settles (seed only). */
async function drive(
  c: SeedContexts,
  workspaceId: string,
  postDestinationId: string,
): Promise<DestinationState> {
  for (let i = 0; i < 25; i++) {
    const pd = await withTenant(c.worker.db, { workspaceId }, (tx) =>
      tx
        .selectFrom('postDestinations as pd')
        .leftJoin('publishIntents as i', 'i.id', 'pd.activeIntentId')
        .select(['pd.state', 'pd.stateReason', 'i.id as intentId', 'i.intentVersion'])
        .where('pd.id', '=', postDestinationId)
        .executeTakeFirstOrThrow(),
    );
    const state = pd.state as DestinationState;
    if (!pd.intentId) return state;
    if (state === 'needs_reconciliation') {
      if (pd.stateReason === 'operator_review_required') return state;
      const r = await reconcilePublish(
        c.worker,
        { workspaceId, postDestinationId, intentId: pd.intentId },
        { workerId: 'seed' },
      );
      if (r === 'indeterminate') return 'needs_reconciliation';
      continue;
    }
    if (!['scheduled', 'preparing', 'dispatching', 'processing'].includes(state)) return state;
    const outcome = await advancePublish(
      c.worker,
      { workspaceId, postDestinationId, intentId: pd.intentId, intentVersion: pd.intentVersion! },
      { workerId: 'seed' },
    );
    if (outcome.kind === 'deferred') c.clock.set(new Date(Date.parse(outcome.until) + 1000));
    else if (
      outcome.kind === 'step' &&
      ['waiting', 'rate_limited', 'retryable'].includes(outcome.result)
    )
      c.clock.advance(5 * 60_000);
    else if (outcome.kind === 'blocked' || outcome.kind === 'stale' || outcome.kind === 'held')
      break;
  }
  const final = await withTenant(c.worker.db, { workspaceId }, (tx) =>
    tx
      .selectFrom('postDestinations')
      .select('state')
      .where('id', '=', postDestinationId)
      .executeTakeFirstOrThrow(),
  );
  return final.state as DestinationState;
}

export interface SeedSummary {
  workspaces: Array<{ slug: string; pages: number; posts: number }>;
  users: string[];
}

/**
 * Whether the demo data is already loaded: the first demo owner exists and holds a membership.
 * Memberships are only visible in that user's own scope (RLS), never from the bootstrap scope.
 */
export async function demoSeeded(ctx: ServiceContext): Promise<boolean> {
  const owner = DEMO_USERS.find((u) => u.key === 'mara')!;
  const user = await withAuthBootstrap(ctx.db, (tx) =>
    tx
      .selectFrom('users')
      .select('id')
      .where('emailNormalized', '=', owner.email)
      .executeTakeFirst(),
  );
  if (!user) return false;
  return withUser(ctx.db, user.id, async (tx) =>
    Boolean(
      await tx
        .selectFrom('workspaceMemberships')
        .select('id')
        .where('userId', '=', user.id)
        .executeTakeFirst(),
    ),
  );
}

export async function seedDemo(
  config: RelayConfig,
  options: { log?: (m: string) => void; fixturesDir?: string } = {},
): Promise<SeedSummary> {
  const log = options.log ?? (() => {});
  if (!config.demoMode || config.isProduction)
    throw new Error('The demo seed only runs with RELAY_DEMO_MODE=true outside production.');
  const fixturesDir = options.fixturesDir ?? path.join(REPO_ROOT, 'fixtures/media');
  const realNow = new Date();
  const clock = new ManualClock(realNow);
  const c: SeedContexts = {
    app: createServiceContext({ config, role: 'app', clock, poolMax: 4 }),
    worker: createServiceContext({ config, role: 'worker', clock, poolMax: 4 }),
    clock,
    fixturesDir,
  };
  try {
    // Idempotent: a seeded database is recognised before any media is generated or uploaded,
    // so a worker that seeds on every start (hosted staging) is cheap to restart.
    if (await demoSeeded(c.app)) {
      log('demo data already present (run `pnpm db:reset` first to reseed)');
      return { workspaces: [], users: DEMO_USERS.map((u) => u.email) };
    }
    if (!existsSync(path.join(fixturesDir, 'manifest.json'))) {
      log('generating synthetic media fixtures…');
      await generateFixtures({ outDir: fixturesDir, ffmpegPath: config.media.ffmpegPath });
    }
    const users = Object.fromEntries(
      await Promise.all(DEMO_USERS.map(async (u) => [u.key, await ensureUser(c.app, u)] as const)),
    ) as Record<(typeof DEMO_USERS)[number]['key'], AuthenticatedUser>;

    // ---- Tenant A: Fernhill Studio --------------------------------------------------------
    log('creating Fernhill Studio…');
    const fernhill = await createWorkspace(
      c.app,
      users.mara,
      { name: 'Fernhill Studio', slug: 'fernhill', timezone: 'Europe/Berlin', weekStart: 'monday' },
      meta,
      { isDemo: true },
    );
    const coffee = await createPage(
      c.app,
      users.mara,
      fernhill.id,
      {
        name: 'Fernhill Coffee',
        timezone: 'Europe/Berlin',
        goal: 'views',
        topics: ['brewing', 'origins'],
        contentPillars: ['How-to', 'Behind the bar'],
      },
      meta,
      { isSample: true },
    );
    const trail = await createPage(
      c.app,
      users.mara,
      fernhill.id,
      {
        name: 'Fernhill Trail Club',
        timezone: 'Europe/Berlin',
        goal: 'followers',
        topics: ['trail running'],
        contentPillars: ['Routes', 'Gear'],
      },
      meta,
      { isSample: true },
    );
    const lab = await createPage(
      c.app,
      users.mara,
      fernhill.id,
      {
        name: 'Simulator lab',
        timezone: 'Europe/Berlin',
        goal: 'views',
        topics: ['demo'],
        contentPillars: [],
      },
      meta,
      { isSample: true },
    );

    const connect = async (
      provider: 'youtube' | 'instagram' | 'facebook_page' | 'tiktok',
      displayName: string,
      profile: SimulatorProfile,
      pageId: string,
    ) => {
      const account = await createDemoConnection(
        c.app,
        users.mara,
        fernhill.id,
        { provider, displayName, profile },
        meta,
      );
      const dest = await addPageDestination(
        c.app,
        users.mara,
        fernhill.id,
        pageId,
        { socialAccountId: account.id, defaultVisibility: 'public' },
        meta,
      );
      return dest.id;
    };
    const coffeeYt = await connect('youtube', 'Fernhill Coffee', 'reliable', coffee.id);
    const coffeeIg = await connect('instagram', 'fernhill.coffee', 'reliable', coffee.id);
    const coffeeFb = await connect(
      'facebook_page',
      'Fernhill Coffee',
      'slow_processing',
      coffee.id,
    );
    await connect('tiktok', 'fernhillcoffee', 'reliable', coffee.id);
    const trailYt = await connect('youtube', 'Fernhill Trail Club', 'reliable', trail.id);
    const trailIg = await connect('instagram', 'fernhill.trail', 'reliable', trail.id);
    const labReject = await connect('instagram', 'Lab · rejects media', 'reject_format', lab.id);
    const labAmbiguous = await connect(
      'facebook_page',
      'Lab · ambiguous outcome',
      'ambiguous',
      lab.id,
    );
    const labLost = await connect('youtube', 'Lab · lost response', 'lost_response', lab.id);
    await connect('youtube', 'Lab · rate limited once', 'rate_limited_once', lab.id);

    log('inviting the Fernhill team…');
    const join = async (
      u: AuthenticatedUser,
      role: 'admin' | 'publisher' | 'editor' | 'viewer',
      pageIds?: string[],
    ) => {
      const invite = await inviteMember(
        c.app,
        users.mara,
        fernhill.id,
        { email: u.email, role, allPages: !pageIds, pageIds: pageIds ?? [] },
        meta,
      );
      await acceptInvitation(c.app, u, { token: invite.token }, meta);
    };
    await join(users.theo, 'admin');
    await join(users.priya, 'publisher', [coffee.id]);
    await join(users.eli, 'editor');
    await join(users.vic, 'viewer');

    log('uploading and validating synthetic media…');
    // Upload (and declare rights) before the sample history begins: rights must already be
    // valid at every past publish time the history below replays.
    clock.set(new Date(realNow.getTime() - 14 * 86_400_000));
    const video = await upload(
      c,
      users.eli,
      fernhill.id,
      coffee.id,
      'vertical-1080x1920-8s.mp4',
      'video/mp4',
    );
    const landscape = await upload(
      c,
      users.eli,
      fernhill.id,
      coffee.id,
      'landscape-1280x720-6s.mp4',
      'video/mp4',
    );
    const portrait = await upload(
      c,
      users.eli,
      fernhill.id,
      coffee.id,
      'portrait-1080x1350.jpg',
      'image/jpeg',
    );
    const square = await upload(
      c,
      users.eli,
      fernhill.id,
      coffee.id,
      'square-1080.png',
      'image/png',
    );
    const wide = await upload(
      c,
      users.eli,
      fernhill.id,
      coffee.id,
      'landscape-1600x900.jpg',
      'image/jpeg',
    );
    const trailVideo = await upload(
      c,
      users.eli,
      fernhill.id,
      trail.id,
      'vertical-1080x1920-8s.mp4',
      'video/mp4',
    );
    const labVideo = await upload(
      c,
      users.mara,
      fernhill.id,
      lab.id,
      'vertical-1080x1920-8s.mp4',
      'video/mp4',
    );

    // ---- History: published posts with results, produced under a clock in the past --------
    log('publishing sample history through the simulator…');
    const history = [
      { daysAgo: 12, title: 'Sample · V60 pour-over basics', dest: [coffeeYt, coffeeIg] },
      { daysAgo: 9, title: 'Sample · Grind size, explained', dest: [coffeeYt, coffeeIg, coffeeFb] },
      { daysAgo: 6, title: 'Sample · Cold brew in two steps', dest: [coffeeIg] },
      { daysAgo: 4, title: 'Sample · Tasting notes', dest: [coffeeYt] },
    ];
    for (const h of history) {
      clock.set(new Date(realNow.getTime() - h.daysAgo * 86_400_000));
      const p = await approvedPost(c, users.mara, fernhill.id, {
        pageId: coffee.id,
        title: h.title,
        caption: `${h.title.replace('Sample · ', '')} — sample caption for the demo. #coffee`,
        assetIds: [video],
        destinationIds: h.dest,
      });
      for (const d of p.destinations) {
        await scheduleDestination(
          c.app,
          users.mara,
          fernhill.id,
          d.id,
          { expectedVersion: d.version, mode: 'asap' },
          meta,
        );
        clock.advance(10_000);
        await drive(c, fernhill.id, d.id);
      }
      const pubs = await withTenant(c.worker.db, { workspaceId: fernhill.id }, (tx) =>
        tx
          .selectFrom('externalPublications as e')
          .innerJoin('postDestinations as pd', 'pd.id', 'e.postDestinationId')
          .select(['e.id', 'e.publishedAt'])
          .where('pd.postId', '=', p.postId)
          .execute(),
      );
      for (const pub of pubs) {
        for (const bucket of AGE_BUCKETS) {
          const at = pub.publishedAt.getTime() + bucket.hours * 3600_000;
          if (at > realNow.getTime()) continue;
          clock.set(new Date(at));
          await refreshMetrics(c.worker, {
            workspaceId: fernhill.id,
            externalPublicationId: pub.id,
            ageBucket: bucket.key,
          });
        }
        clock.set(realNow);
        await refreshMetrics(c.worker, {
          workspaceId: fernhill.id,
          externalPublicationId: pub.id,
          ageBucket: null,
        });
      }
    }
    clock.set(realNow);

    // ---- A week of finished posts on the calendar (marketer flow) ------------------------
    // The Fernhill Coffee YouTube account is deliberately left without future reservations:
    // the guided tour and the end-to-end gate schedule a post there "as soon as possible",
    // which the pacing rules (2 h minimum gap, daily cap) must not refuse at any time of day.
    log('scheduling a week of sample posts…');
    const week = [
      { title: 'Sample · Espresso dial-in', assets: [landscape], dest: [coffeeIg] },
      { title: 'Sample · Latte art carousel', assets: [portrait, square, wide], dest: [coffeeIg] },
      { title: 'Sample · Single-origin spotlight', assets: [video], dest: [coffeeIg, coffeeFb] },
      { title: 'Sample · Barista Q&A', assets: [video], dest: [coffeeIg] },
      { title: 'Sample · Weekend brew guide', assets: [video], dest: [coffeeFb] },
    ];
    for (const w of week) {
      const p = await approvedPost(c, users.priya, fernhill.id, {
        pageId: coffee.id,
        title: w.title,
        caption: `${w.title.replace('Sample · ', '')} — sample caption.`,
        assetIds: w.assets,
        destinationIds: w.dest,
      });
      for (const d of p.destinations) {
        const rec = await recommendSlotsFor(c.app, users.priya, fernhill.id, {
          postDestinationIds: [d.id],
          count: 1,
          horizonDays: 7,
        });
        const slot = rec.results[0]?.suggestions[0];
        if (!slot) continue;
        await scheduleDestination(
          c.app,
          users.priya,
          fernhill.id,
          d.id,
          { expectedVersion: d.version, mode: 'at', localTime: slot.civil, offset: slot.offset },
          meta,
        ).catch(() => undefined);
      }
    }

    // Review queue and a draft.
    await approvedPost(c, users.eli, fernhill.id, {
      pageId: coffee.id,
      title: 'Sample · Milk steaming tips',
      caption: 'Needs a publisher’s review — sample caption.',
      assetIds: [video],
      destinationIds: [coffeeYt, coffeeIg],
      approve: false,
    });
    await approvedPost(c, users.eli, fernhill.id, {
      pageId: trail.id,
      title: 'Sample · Ridge loop route',
      caption: 'Draft — sample caption.',
      assetIds: [trailVideo],
      destinationIds: [trailYt, trailIg],
      submit: false,
    });

    // ---- Simulator lab: mixed outcomes on one post -----------------------------------------
    log('running the simulator lab (mixed outcomes)…');
    const labPost = await approvedPost(c, users.mara, fernhill.id, {
      pageId: lab.id,
      title: 'Sample · Mixed outcomes demo',
      caption: 'One post, three simulated platforms with scripted behaviour.',
      assetIds: [labVideo],
      destinationIds: [labReject, labAmbiguous, labLost],
    });
    clock.set(new Date(realNow.getTime() - 2 * 3600_000));
    for (const d of labPost.destinations) {
      await scheduleDestination(
        c.app,
        users.mara,
        fernhill.id,
        d.id,
        { expectedVersion: d.version, mode: 'asap' },
        meta,
      ).catch(() => undefined);
    }
    clock.advance(10_000);
    for (const d of labPost.destinations) await drive(c, fernhill.id, d.id);
    clock.set(realNow);

    // ---- Tenant B: Kestrel Media (isolation demo) ---------------------------------------------
    log('creating Kestrel Media…');
    const kestrel = await createWorkspace(
      c.app,
      users.gus,
      { name: 'Kestrel Media', slug: 'kestrel', timezone: 'Europe/London', weekStart: 'monday' },
      meta,
      { isDemo: true },
    );
    const daily = await createPage(
      c.app,
      users.gus,
      kestrel.id,
      { name: 'Kestrel Daily', timezone: 'Europe/London', goal: 'watch_time' },
      meta,
      { isSample: true },
    );
    const kAccount = await createDemoConnection(
      c.app,
      users.gus,
      kestrel.id,
      { provider: 'youtube', displayName: 'Kestrel Daily', profile: 'reliable' },
      meta,
    );
    const kDest = await addPageDestination(
      c.app,
      users.gus,
      kestrel.id,
      daily.id,
      { socialAccountId: kAccount.id },
      meta,
    );
    const kInvite = await inviteMember(
      c.app,
      users.gus,
      kestrel.id,
      { email: users.kim.email, role: 'editor' },
      meta,
    );
    await acceptInvitation(c.app, users.kim, { token: kInvite.token }, meta);
    const kVideo = await upload(
      c,
      users.kim,
      kestrel.id,
      daily.id,
      'landscape-1280x720-6s.mp4',
      'video/mp4',
    );
    await approvedPost(c, users.kim, kestrel.id, {
      pageId: daily.id,
      title: 'Sample · Morning headlines',
      caption: 'Kestrel-only sample draft.',
      assetIds: [kVideo],
      destinationIds: [kDest.id],
      submit: false,
    });

    return {
      workspaces: [
        { slug: 'fernhill', pages: 3, posts: history.length + week.length + 3 },
        { slug: 'kestrel', pages: 1, posts: 1 },
      ],
      users: DEMO_USERS.map((u) => u.email),
    };
  } finally {
    await c.app.db.destroy();
    await c.worker.db.destroy();
  }
}
