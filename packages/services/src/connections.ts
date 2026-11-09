import { sql, type Tx } from '@relay/db';
import {
  AppError,
  CAPABILITY_KEYS,
  createDemoConnectionSchema,
  createDestinationSchema,
  PROVIDER_LABELS,
  resolveCapability,
  type Capability,
  type CapabilityKey,
  type DestinationProviderId,
} from '@relay/domain';
import { randomToken } from '@relay/domain/server';
import {
  PROVIDER_CATALOG,
  SIMULATED_ACCOUNT_TYPES,
  SIMULATOR_FORMAT_PROFILES,
  type ConnectedAccount,
  type PublishingCapabilities,
  type SimulatorProfile,
} from '@relay/providers';
import { authorize, inWorkspace, memberActor, requirePage, type AuthenticatedUser } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';

export interface AccountRow {
  id: string;
  workspaceId: string;
  grantId: string;
  provider: string;
  connectionMode: string;
  providerAccountId: string;
  displayName: string;
  handle: string | null;
  accountType: string;
  simulatorProfile: string | null;
  status: string;
  healthReason: string | null;
  connectionGeneration: number;
}

export function toConnectedAccount(row: AccountRow, grantedScopes: readonly string[] = []): ConnectedAccount {
  return {
    workspaceId: row.workspaceId,
    socialAccountId: row.id,
    provider: row.provider as DestinationProviderId,
    connectionMode: row.connectionMode as 'simulated' | 'live',
    providerAccountId: row.providerAccountId,
    accountType: row.accountType,
    grantedScopes,
    status: row.status as ConnectedAccount['status'],
    simulatorProfile: (row.simulatorProfile as SimulatorProfile | null) ?? null,
  };
}

/** Publishing capabilities of an account, or null when no adapter is available. */
export async function adapterCapabilities(ctx: ServiceContext, account: ConnectedAccount): Promise<PublishingCapabilities | null> {
  const adapter = ctx.registry.publishing(account.provider, account.connectionMode);
  if (adapter) return adapter.capabilities(account);
  // No adapter in this process (e.g. the web app) — derive the simulator's static profile so
  // the UI can show the same rules the worker will enforce.
  if (account.connectionMode === 'simulated' && ctx.config.demoMode) {
    const profile = SIMULATOR_FORMAT_PROFILES[account.provider];
    return {
      provider: account.provider,
      mode: 'simulated',
      profile,
      requiredScopes: {},
      implemented: { 'publish.video': true, 'publish.image': true, 'publish.carousel': true, 'metrics.read': true, 'export.manual': true },
      programApproval: 'not_required',
      accountTypeSupported: account.accountType === SIMULATED_ACCOUNT_TYPES[account.provider],
    };
  }
  return null;
}

export function evaluateCapabilities(
  ctx: ServiceContext,
  account: ConnectedAccount,
  caps: PublishingCapabilities | null,
): Record<CapabilityKey, Capability> {
  const now = ctx.clock.now();
  const health =
    account.status === 'active' ? 'healthy' : account.status === 'needs_reauth' ? 'needs_reauth' : 'revoked';
  const result = {} as Record<CapabilityKey, Capability>;
  for (const key of CAPABILITY_KEYS) {
    if (key === 'export.manual') {
      result[key] = { state: 'enabled', message: 'Download the prepared file and post it yourself.', fallback: null, checkedAt: now.toISOString() };
      continue;
    }
    const formatKey = key === 'publish.video' ? 'video' : key === 'publish.image' ? 'image' : key === 'publish.carousel' ? 'carousel' : null;
    result[key] = resolveCapability(
      {
        implemented: caps ? (caps.implemented[key] ?? false) : false,
        connectionMode: account.connectionMode,
        demoMode: ctx.config.demoMode,
        deploymentEnabled: account.connectionMode === 'simulated' ? true : ctx.config.providers[account.provider].enabled,
        programApproval: caps?.programApproval ?? 'not_required',
        requiredScopes: caps?.requiredScopes[key] ?? [],
        grantedScopes: account.grantedScopes,
        accountTypeSupported: caps?.accountTypeSupported ?? false,
        // The adapter exists; whether this destination accepts the format is a separate check.
        formatSupported: formatKey ? Boolean(caps?.profile[formatKey]) : true,
        visibilitySupported: true,
        policyAllows: true,
        runtimeHealth: health,
        publishMode: key.startsWith('publish.') ? caps?.profile.publishMode : 'api',
      },
      now,
    );
  }
  return result;
}

async function snapshotCapabilities(tx: Tx, ctx: ServiceContext, workspaceId: string, account: ConnectedAccount) {
  const caps = evaluateCapabilities(ctx, account, await adapterCapabilities(ctx, account));
  for (const [capability, value] of Object.entries(caps)) {
    await tx
      .insertInto('providerCapabilities')
      .values({
        id: ctx.ids.next(),
        workspaceId,
        socialAccountId: account.socialAccountId,
        capability,
        state: value.state,
        reasonCode: value.reasonCode ?? null,
        checkedAt: new Date(value.checkedAt),
      })
      .onConflict((oc) =>
        oc.columns(['socialAccountId', 'capability']).doUpdateSet({
          state: value.state,
          reasonCode: value.reasonCode ?? null,
          checkedAt: new Date(value.checkedAt),
        }),
      )
      .execute();
  }
  return caps;
}

export async function listConnections(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'connections.view');
    const rows = await tx
      .selectFrom('socialAccounts as a')
      .innerJoin('providerGrants as g', 'g.id', 'a.grantId')
      .select([
        'a.id', 'a.workspaceId', 'a.grantId', 'a.provider', 'a.connectionMode', 'a.providerAccountId', 'a.displayName',
        'a.handle', 'a.accountType', 'a.simulatorProfile', 'a.status', 'a.healthReason', 'a.healthCheckedAt',
        'a.connectionGeneration', 'a.createdAt', 'g.grantedScopes',
      ])
      .orderBy('a.provider')
      .orderBy('a.displayName')
      .execute();
    const destinations = await tx
      .selectFrom('pageDestinations as d')
      .innerJoin('pages as p', 'p.id', 'd.pageId')
      .select(['d.id', 'd.socialAccountId', 'd.label', 'p.id as pageId', 'p.name as pageName'])
      .where('d.archivedAt', 'is', null)
      .execute();
    const accounts = [];
    for (const row of rows) {
      const account = toConnectedAccount(row, row.grantedScopes);
      const caps = await adapterCapabilities(ctx, account);
      accounts.push({
        ...row,
        capabilities: evaluateCapabilities(ctx, account, caps),
        formatProfile: caps?.profile ?? null,
        usedBy: destinations.filter((d) => d.socialAccountId === row.id),
      });
    }
    const providers = Object.values(PROVIDER_CATALOG).map((entry) => ({
      ...entry,
      liveEnabled: ctx.config.providers[entry.id].enabled,
      liveConnectAvailable: false,
      liveUnavailableReason:
        entry.live.status === 'planned'
          ? `The live ${entry.label} integration is planned for ${entry.live.milestone} and is not implemented in this build.`
          : null,
      simulatedAvailable: ctx.config.demoMode && entry.roles.includes('destination'),
    }));
    return { member, accounts, providers, demoMode: ctx.config.demoMode };
  });
}

/** Demo mode only: connect a simulated account driven by the provider simulator. */
export async function createDemoConnection(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, rawInput: unknown, meta: RequestMeta) {
  if (!ctx.config.demoMode || ctx.config.isProduction) {
    throw new AppError('demo_mode_disabled', 'Simulated connections are only available in demo mode.');
  }
  const input = createDemoConnectionSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'connections.manage');
    const grantId = ctx.ids.next();
    const accountId = ctx.ids.next();
    await tx
      .insertInto('providerGrants')
      .values({ id: grantId, workspaceId, provider: input.provider, connectionMode: 'simulated', grantedScopes: [], createdBy: user.userId })
      .execute();
    const handle = input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'demo';
    const row = {
      id: accountId,
      workspaceId,
      grantId,
      provider: input.provider,
      connectionMode: 'simulated',
      providerAccountId: `sim-${input.provider}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`,
      displayName: input.displayName,
      handle: `@${handle}`,
      accountType: SIMULATED_ACCOUNT_TYPES[input.provider],
      simulatorProfile: input.profile,
      status: 'active',
      healthReason: null,
      connectionGeneration: 0,
    } satisfies AccountRow;
    await tx.insertInto('socialAccounts').values({ ...row, createdBy: user.userId, healthCheckedAt: ctx.clock.now() }).execute();
    const caps = await snapshotCapabilities(tx, ctx, workspaceId, toConnectedAccount(row));
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'connection.created',
      entityType: 'social_account',
      entityId: accountId,
      data: { provider: input.provider, mode: 'simulated', profile: input.profile },
      requestId: meta.requestId,
    });
    return { id: accountId, capabilities: caps, label: `${PROVIDER_LABELS[input.provider]} · ${input.displayName} (simulated)` };
  });
}

/**
 * Disconnect an account: bump its connection generation so no new dispatch claim can use it,
 * and hold every not-yet-claimed destination that targets it. In-flight work is not hidden:
 * it is reported so an operator can reconcile it.
 */
export async function disconnectAccount(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, accountId: string, meta: RequestMeta) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'connections.manage');
    // Lock order: social account first (same as schedule and claim).
    const account = await tx.selectFrom('socialAccounts').select(['id', 'status']).where('id', '=', accountId).forUpdate().executeTakeFirst();
    if (!account) throw new AppError('not_found', 'Connection not found');
    const now = ctx.clock.now();
    await tx
      .updateTable('socialAccounts')
      .set({ status: 'disconnected', disconnectedAt: now, healthReason: 'disconnected_by_user', connectionGeneration: sql`connection_generation + 1` })
      .where('id', '=', accountId)
      .execute();
    const affected = await tx
      .selectFrom('postDestinations as pd')
      .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
      .select(['pd.id', 'pd.state'])
      .where('d.socialAccountId', '=', accountId)
      .where('pd.state', 'in', ['scheduled', 'preparing', 'dispatching', 'processing'])
      .forUpdate()
      .execute();
    const held = affected.filter((d) => d.state === 'scheduled' || d.state === 'preparing');
    if (held.length) {
      await tx
        .updateTable('postDestinations')
        .set({ state: 'blocked', stateReason: 'connection_revoked', stateChangedAt: now, version: sql`version + 1` })
        .where('id', 'in', held.map((d) => d.id))
        .execute();
    }
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'connection.disconnected',
      entityType: 'social_account',
      entityId: accountId,
      data: { held: held.length, inFlight: affected.length - held.length },
      requestId: meta.requestId,
    });
    return { held: held.length, inFlight: affected.filter((d) => d.state === 'dispatching' || d.state === 'processing').map((d) => d.id) };
  });
}

export async function addPageDestination(ctx: ServiceContext, user: AuthenticatedUser, workspaceId: string, pageId: string, rawInput: unknown, meta: RequestMeta) {
  const input = createDestinationSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'page.update', pageId);
    await requirePage(tx, member, pageId);
    const account = await tx.selectFrom('socialAccounts').selectAll().where('id', '=', input.socialAccountId).executeTakeFirst();
    if (!account) throw new AppError('not_found', 'Connection not found');
    if (account.status !== 'active') throw new AppError('connection_unhealthy', 'Reconnect this account before adding it to a page.');
    if (account.provider === 'twitch') throw new AppError('validation_failed', 'Twitch is a source, not a publishing destination.');
    const id = ctx.ids.next();
    try {
      await tx
        .insertInto('pageDestinations')
        .values({
          id,
          workspaceId,
          pageId,
          socialAccountId: account.id,
          provider: account.provider,
          label: input.label ?? `${PROVIDER_LABELS[account.provider as DestinationProviderId]} · ${account.displayName}`,
          defaultVisibility: input.defaultVisibility,
          createdBy: user.userId,
        })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('validation_failed', 'This account is already a destination of this page.');
      }
      throw error;
    }
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'page.destination_added',
      entityType: 'page_destination',
      entityId: id,
      pageId,
      data: { provider: account.provider, socialAccountId: account.id },
      requestId: meta.requestId,
    });
    return { id };
  });
}
