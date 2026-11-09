import { sql, withTenant, type Tx } from '@relay/db';
import {
  AGE_BUCKETS,
  canTransition,
  type BlockReason,
  type DestinationState,
  type TransitionTrigger,
} from '@relay/domain';
import { fingerprint } from '@relay/domain/server';
import {
  ProviderTimeoutError,
  type ConnectedAccount,
  type PublishCheckpoint,
  type PublishingAdapter,
  type PublishIntent,
  type PublishPhase,
  type StepResult,
} from '@relay/providers';
import { appendAudit, SERVICE_ACTORS } from './audit';
import { toConnectedAccount } from './connections';
import type { ServiceContext } from './context';
import { destinationRefs, transitionDestination } from './destinations';
import {
  buildDestinationIntent,
  loadDestinationTargets,
  loadRevisionBundle,
  type BuiltIntent,
} from './intents';
import { safeError } from './logger';
import { enqueue, type TaskPayload } from './tasks';

/**
 * Durable publish workflow (worker). One `advance` executes at most one provider step:
 *
 *   A. transaction: lock account → page → workspace (FOR SHARE) and the destination (FOR
 *      UPDATE); drop stale/duplicate deliveries; re-check eligibility (pause, connection,
 *      approval hash, rights, media, capability, lateness) for anything not yet public;
 *      refuse early dispatch; then take a fenced lease and write an in-flight attempt
 *      (operation ID + request fingerprint) BEFORE the side effect. The committed claim is
 *      the dispatch boundary.
 *   B. the provider call, outside any transaction, with a strict timeout.
 *   C. transaction: re-lock the destination and persist the result only if this worker
 *      still holds the lease token (fencing); schedule the next step from legal transitions.
 *
 * A crash after B but before C leaves an in-flight attempt; the next claimant treats a
 * side-effecting one as an unknown outcome and reconciles instead of resending.
 */

export interface AdvanceOptions {
  workerId: string;
  callTimeoutMs?: number;
  leaseMs?: number;
  maxRetries?: number;
}

export type AdvanceOutcome =
  | { kind: 'stale' }
  | { kind: 'leased' }
  | { kind: 'held'; reason: string }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'deferred'; until: string }
  | { kind: 'reconcile' }
  | { kind: 'step'; result: StepResult['kind']; phase: PublishPhase }
  | { kind: 'lost_lease' };

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;

interface ClaimContext {
  token: number;
  attemptId: string;
  phase: PublishPhase;
  checkpoint: PublishCheckpoint;
  intent: PublishIntent;
  account: ConnectedAccount;
  adapter: PublishingAdapter;
  pageId: string;
  postId: string;
  plannedAt: Date;
  attemptNumber: number;
}

async function loadIntentForAdapter(
  tx: Tx,
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    postId: string;
    postDestinationId: string;
    revisionId: string;
    at: Date;
  },
): Promise<{ built: BuiltIntent; media: PublishIntent['media'] }> {
  const bundle = await loadRevisionBundle(tx, input.revisionId);
  const target = (await loadDestinationTargets(tx, input.postId)).find(
    (t) => t.postDestinationId === input.postDestinationId,
  )!;
  const built = await buildDestinationIntent(tx, ctx, {
    workspaceId: input.workspaceId,
    bundle,
    target,
    at: input.at,
  });
  return {
    built,
    media: bundle.media.map(({ status: _s, pageId: _p, rightsVersion: _r, ...m }) => m),
  };
}

async function blockDestination(
  tx: Tx,
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    postDestinationId: string;
    state: DestinationState;
    reason: BlockReason;
    pageId: string;
    postId: string;
    correlationId?: string;
  },
): Promise<AdvanceOutcome> {
  await transitionDestination(tx, {
    postDestinationId: input.postDestinationId,
    from: input.state,
    trigger: 'block',
    reason: input.reason,
    now: ctx.clock.now(),
  });
  await appendAudit(tx, ctx.ids, {
    workspaceId: input.workspaceId,
    actor: SERVICE_ACTORS.publisher,
    action: 'publish.blocked',
    entityType: 'post_destination',
    entityId: input.postDestinationId,
    pageId: input.pageId,
    postId: input.postId,
    data: { reason: input.reason },
    correlationId: input.correlationId ?? null,
  });
  return { kind: 'blocked', reason: input.reason };
}

export async function advancePublish(
  ctx: ServiceContext,
  payload: TaskPayload<'publish.advance'>,
  options: AdvanceOptions,
): Promise<AdvanceOutcome> {
  const { workspaceId, postDestinationId, intentId, intentVersion } = payload;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;

  // ---------------------------------------------------------------- A. eligibility + claim
  const claimed = await withTenant(
    ctx.db,
    { workspaceId },
    async (tx): Promise<AdvanceOutcome | ClaimContext> => {
      const now = ctx.clock.now();
      const refs = await destinationRefs(tx, postDestinationId);
      if (!refs) return { kind: 'stale' };
      const accountRow = await tx
        .selectFrom('socialAccounts')
        .selectAll()
        .where('id', '=', refs.socialAccountId)
        .forShare()
        .executeTakeFirstOrThrow();
      const page = await tx
        .selectFrom('pages')
        .select(['id', 'pausedAt'])
        .where('id', '=', refs.pageId)
        .forShare()
        .executeTakeFirstOrThrow();
      const workspace = await tx
        .selectFrom('workspaces')
        .select(['id', 'pausedAt'])
        .where('id', '=', workspaceId)
        .forShare()
        .executeTakeFirstOrThrow();
      const pd = await tx
        .selectFrom('postDestinations')
        .selectAll()
        .where('id', '=', postDestinationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const intent = await tx
        .selectFrom('publishIntents')
        .selectAll()
        .where('id', '=', intentId)
        .executeTakeFirst();
      // Stale, superseded, canceled or duplicate deliveries are no-ops.
      if (
        !intent ||
        intent.status !== 'active' ||
        pd.activeIntentId !== intent.id ||
        intent.intentVersion !== intentVersion
      )
        return { kind: 'stale' };
      const state = pd.state as DestinationState;
      if (!['scheduled', 'preparing', 'dispatching', 'processing'].includes(state))
        return { kind: 'stale' };
      if (
        pd.leaseOwner &&
        pd.leaseExpiresAt &&
        pd.leaseExpiresAt > now &&
        pd.leaseOwner !== options.workerId
      )
        return { kind: 'leased' };

      const grant = await tx
        .selectFrom('providerGrants')
        .select(['grantedScopes'])
        .where('id', '=', accountRow.grantId)
        .executeTakeFirstOrThrow();
      const account = toConnectedAccount(accountRow, grant.grantedScopes);
      const adapter = ctx.registry.publishing(account.provider, account.connectionMode);
      const blockCtx = {
        workspaceId,
        postDestinationId,
        state,
        pageId: refs.pageId,
        postId: refs.postId,
        correlationId: payload.correlationId,
      };

      // A previous worker died after writing an in-flight attempt.
      const inflight = await tx
        .selectFrom('publishAttempts')
        .selectAll()
        .where('postDestinationId', '=', postDestinationId)
        .where('status', '=', 'in_flight')
        .executeTakeFirst();
      if (inflight) {
        if (inflight.sideEffecting) {
          await tx
            .updateTable('publishAttempts')
            .set({
              status: 'unknown',
              finishedAt: now,
              errorCode: 'worker_lost',
              errorMessage: 'The worker stopped before recording the platform response.',
            })
            .where('id', '=', inflight.id)
            .execute();
          if (canTransition(state, 'unknown_outcome')) {
            await transitionDestination(tx, {
              postDestinationId,
              from: state,
              trigger: 'unknown_outcome',
              reason: 'worker_lost',
              now,
              set: { leaseOwner: null, leaseExpiresAt: null },
            });
          }
          await enqueue(
            tx,
            'publish.reconcile',
            { workspaceId, postDestinationId, intentId, correlationId: payload.correlationId },
            { jobKey: `reconcile:${postDestinationId}` },
          );
          await appendAudit(tx, ctx.ids, {
            workspaceId,
            actor: SERVICE_ACTORS.publisher,
            action: 'publish.outcome_unknown',
            entityType: 'post_destination',
            entityId: postDestinationId,
            pageId: refs.pageId,
            postId: refs.postId,
            data: { phase: inflight.phase, code: 'worker_lost' },
            correlationId: payload.correlationId ?? null,
          });
          return { kind: 'reconcile' };
        }
        await tx
          .updateTable('publishAttempts')
          .set({ status: 'abandoned', finishedAt: now, errorCode: 'worker_lost' })
          .where('id', '=', inflight.id)
          .execute();
      }

      const phase =
        (pd.checkpointPhase as PublishPhase | null) ?? adapter?.initialPhase() ?? 'prepare';
      const claimedForDispatch = state === 'dispatching' || state === 'processing';

      // Before the dispatch claim, everything is re-validated against committed state.
      let built: BuiltIntent | null = null;
      let media: PublishIntent['media'] = [];
      if (!claimedForDispatch) {
        if (ctx.config.ops.publishKillSwitch) {
          await enqueue(tx, 'publish.advance', payload, {
            runAt: new Date(now.getTime() + 60_000),
            jobKey: `publish:${postDestinationId}`,
          });
          return { kind: 'held', reason: 'kill_switch' };
        }
        if (workspace.pausedAt)
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'workspace_paused' });
        if (page.pausedAt) return blockDestination(tx, ctx, { ...blockCtx, reason: 'page_paused' });
        if (accountRow.status === 'disconnected' || accountRow.status === 'revoked')
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'connection_revoked' });
        if (accountRow.status !== 'active')
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'connection_unhealthy' });
        if (accountRow.connectionGeneration !== intent.connectionGeneration)
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'connection_revoked' });
        if (!adapter) {
          return blockDestination(tx, ctx, {
            ...blockCtx,
            reason:
              account.connectionMode === 'simulated'
                ? 'simulator_disabled'
                : 'capability_unavailable',
          });
        }
        const approval = await tx
          .selectFrom('approvals')
          .select(['id', 'intentHash'])
          .where('id', '=', intent.approvalId)
          .where('invalidatedAt', 'is', null)
          .executeTakeFirst();
        ({ built, media } = await loadIntentForAdapter(tx, ctx, {
          workspaceId,
          postId: refs.postId,
          postDestinationId,
          revisionId: intent.revisionId,
          at: now,
        }));
        if (!built.mediaReady)
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'media_unavailable' });
        if (!built.rights.ok)
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'rights_changed' });
        if (
          !approval ||
          approval.intentHash !== intent.intentHash ||
          built.hash !== intent.intentHash
        ) {
          if (approval)
            await tx
              .updateTable('approvals')
              .set({ invalidatedAt: now, invalidatedReason: 'intent_changed' })
              .where('id', '=', approval.id)
              .execute();
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'approval_invalid' });
        }
        if (built.issues.some((i) => i.blocks === 'schedule'))
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'capability_unavailable' });
        const graceMs = Math.max(ctx.config.ops.lateGraceSeconds * 1000, 0);
        if (pd.attemptCount === 0 && now.getTime() > intent.plannedAt.getTime() + graceMs) {
          return blockDestination(tx, ctx, { ...blockCtx, reason: 'missed_schedule' });
        }
      } else {
        ({ built, media } = await loadIntentForAdapter(tx, ctx, {
          workspaceId,
          postId: refs.postId,
          postDestinationId,
          revisionId: intent.revisionId,
          at: now,
        }));
      }
      if (!adapter)
        return blockDestination(tx, ctx, { ...blockCtx, reason: 'capability_unavailable' });

      // Never dispatch (or run a phase that must not run early) before the planned time.
      if (
        (phase === 'dispatch' || !adapter.mayRunBeforePlannedTime(phase)) &&
        now < intent.plannedAt
      ) {
        await enqueue(tx, 'publish.advance', payload, {
          runAt: intent.plannedAt,
          jobKey: `publish:${postDestinationId}`,
        });
        return { kind: 'deferred', until: intent.plannedAt.toISOString() };
      }

      let trigger: TransitionTrigger | null = null;
      if (phase === 'dispatch' && (state === 'scheduled' || state === 'preparing'))
        trigger = 'claim_dispatch';
      else if (state === 'scheduled') trigger = 'claim_prepare';
      const token = pd.leaseToken + 1;
      const leaseSet = {
        leaseOwner: options.workerId,
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attemptCount: pd.attemptCount + 1,
      };
      if (trigger) {
        await transitionDestination(tx, {
          postDestinationId,
          from: state,
          trigger,
          reason: null,
          now,
          set: leaseSet,
        });
      } else {
        await tx
          .updateTable('postDestinations')
          .set({ ...leaseSet, version: sql`version + 1` })
          .where('id', '=', postDestinationId)
          .execute();
      }
      const checkpoint: PublishCheckpoint = {
        phase,
        ...(pd.checkpointReceiptId ? { receiptId: pd.checkpointReceiptId } : {}),
        ...(pd.checkpointProviderPostId ? { providerPostId: pd.checkpointProviderPostId } : {}),
      };
      const operationId = `${intent.operationKey}:${phase}`;
      const attemptId = ctx.ids.next();
      await tx
        .insertInto('publishAttempts')
        .values({
          id: attemptId,
          workspaceId,
          postDestinationId,
          intentId,
          attemptNumber: pd.attemptCount + 1,
          phase,
          fencingToken: token,
          workerId: options.workerId,
          operationId,
          requestFingerprint: fingerprint({
            operationKey: intent.operationKey,
            phase,
            receiptId: checkpoint.receiptId ?? null,
            intentHash: intent.intentHash,
          }),
          sideEffecting: adapter.isSideEffecting(phase),
          status: 'in_flight',
        })
        .execute();
      if (trigger === 'claim_dispatch') {
        await appendAudit(tx, ctx.ids, {
          workspaceId,
          actor: SERVICE_ACTORS.publisher,
          action: 'publish.dispatch_claimed',
          entityType: 'post_destination',
          entityId: postDestinationId,
          pageId: refs.pageId,
          postId: refs.postId,
          data: {
            intentId,
            plannedAt: intent.plannedAt.toISOString(),
            mode: account.connectionMode,
          },
          correlationId: payload.correlationId ?? null,
        });
      }
      return {
        token,
        attemptId,
        phase,
        checkpoint,
        account,
        adapter,
        pageId: refs.pageId,
        postId: refs.postId,
        plannedAt: intent.plannedAt,
        attemptNumber: pd.attemptCount + 1,
        intent: {
          intentId,
          intentVersion,
          operationKey: intent.operationKey,
          plannedAt: intent.plannedAt.toISOString(),
          payload: built!.payload,
          media,
        },
      };
    },
  );
  if ('kind' in claimed) return claimed;

  // ---------------------------------------------------------------- B. provider call
  const { adapter, phase } = claimed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), callTimeoutMs);
  let result: StepResult;
  try {
    result = await adapter.advance({
      account: claimed.account,
      intent: claimed.intent,
      checkpoint: claimed.checkpoint,
      operationId: `${claimed.intent.operationKey}:${phase}`,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut =
      error instanceof ProviderTimeoutError || (error as { name?: string }).name === 'AbortError';
    const code = timedOut ? 'provider_timeout' : 'adapter_error';
    const message = timedOut ? 'The platform did not respond in time.' : safeError(error).message;
    result = adapter.isSideEffecting(phase)
      ? { kind: 'unknown', code, message }
      : { kind: 'retryable', code, message };
    ctx.logger.warn(
      { postDestinationId, phase, code, err: safeError(error) },
      'provider step failed',
    );
  } finally {
    clearTimeout(timer);
  }

  // ---------------------------------------------------------------- C. fenced commit
  return withTenant(ctx.db, { workspaceId }, async (tx): Promise<AdvanceOutcome> => {
    const now = ctx.clock.now();
    const pd = await tx
      .selectFrom('postDestinations')
      .selectAll()
      .where('id', '=', postDestinationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const attemptUpdate = {
      finishedAt: now,
      ...(result.kind === 'continue' || result.kind === 'waiting' || result.kind === 'confirmed'
        ? {
            receiptId: result.checkpoint.receiptId ?? null,
            providerPostId: result.checkpoint.providerPostId ?? null,
          }
        : {}),
      ...(result.kind === 'confirmed' ? { providerPostId: result.providerPostId } : {}),
      ...('code' in result ? { errorCode: result.code } : {}),
      ...('message' in result ? { errorMessage: result.message.slice(0, 500) } : {}),
    };
    if (pd.leaseToken !== claimed.token || pd.leaseOwner !== options.workerId) {
      // Another worker took over: record what we learned, change nothing else.
      await tx
        .updateTable('publishAttempts')
        .set({
          ...attemptUpdate,
          errorMessage: `Late result (${result.kind}) after the lease was lost.`,
        })
        .where('id', '=', claimed.attemptId)
        .execute();
      await tx
        .updateTable('publishAttempts')
        .set({ status: 'stale' })
        .where('id', '=', claimed.attemptId)
        .where('status', '=', 'in_flight')
        .execute();
      return { kind: 'lost_lease' };
    }
    const state = pd.state as DestinationState;
    const releaseLease = { leaseOwner: null, leaseExpiresAt: null };
    const audit = (action: string, data: Record<string, unknown>) =>
      appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.publisher,
        action,
        entityType: 'post_destination',
        entityId: postDestinationId,
        pageId: claimed.pageId,
        postId: claimed.postId,
        data,
        correlationId: payload.correlationId ?? null,
      });
    const next = (runAt?: Date) =>
      enqueue(tx, 'publish.advance', payload, {
        ...(runAt ? { runAt } : {}),
        jobKey: `publish:${postDestinationId}`,
      });

    switch (result.kind) {
      case 'continue': {
        await tx
          .updateTable('publishAttempts')
          .set({ ...attemptUpdate, status: 'succeeded' })
          .where('id', '=', claimed.attemptId)
          .execute();
        await tx
          .updateTable('postDestinations')
          .set({
            ...releaseLease,
            checkpointPhase: result.checkpoint.phase,
            checkpointReceiptId: result.checkpoint.receiptId ?? null,
            checkpointProviderPostId: result.checkpoint.providerPostId ?? null,
            checkpointNextCheckAt: null,
            version: sql`version + 1`,
          })
          .where('id', '=', postDestinationId)
          .execute();
        await next();
        if (phase === 'dispatch')
          await audit('publish.dispatched', {
            providerPostId: result.checkpoint.providerPostId ?? null,
          });
        return { kind: 'step', result: 'continue', phase };
      }
      case 'waiting': {
        await tx
          .updateTable('publishAttempts')
          .set({ ...attemptUpdate, status: 'waiting' })
          .where('id', '=', claimed.attemptId)
          .execute();
        const set = {
          ...releaseLease,
          checkpointPhase: result.checkpoint.phase,
          checkpointReceiptId: result.checkpoint.receiptId ?? null,
          checkpointProviderPostId: result.checkpoint.providerPostId ?? null,
          checkpointNextCheckAt: new Date(result.nextCheckAt),
        };
        if (state === 'dispatching') {
          await transitionDestination(tx, {
            postDestinationId,
            from: state,
            trigger: 'accepted',
            now,
            set,
          });
        } else {
          await tx
            .updateTable('postDestinations')
            .set({ ...set, version: sql`version + 1` })
            .where('id', '=', postDestinationId)
            .execute();
        }
        await next(new Date(result.nextCheckAt));
        return { kind: 'step', result: 'waiting', phase };
      }
      case 'confirmed': {
        await tx
          .updateTable('publishAttempts')
          .set({ ...attemptUpdate, status: 'succeeded' })
          .where('id', '=', claimed.attemptId)
          .execute();
        await recordPublication(tx, ctx, {
          workspaceId,
          postDestinationId,
          intentId,
          state,
          account: claimed.account,
          externalId: result.providerPostId,
          containerId: result.containerId ?? null,
          permalink: result.permalink ?? null,
          visibility: result.visibility,
          publishedAt: new Date(result.publishedAt),
          plannedAt: claimed.plannedAt,
          format:
            claimed.intent.media.length > 1
              ? 'carousel'
              : (claimed.intent.media[0]?.kind ?? 'video'),
          linkMethod: 'provider_confirmed',
          trigger: 'confirmed',
          pageId: claimed.pageId,
          postId: claimed.postId,
          correlationId: payload.correlationId ?? null,
        });
        return { kind: 'step', result: 'confirmed', phase };
      }
      case 'rejected': {
        await tx
          .updateTable('publishAttempts')
          .set({ ...attemptUpdate, status: 'rejected' })
          .where('id', '=', claimed.attemptId)
          .execute();
        await transitionDestination(tx, {
          postDestinationId,
          from: state,
          trigger: 'rejected_by_provider',
          reason: result.code,
          now,
          set: releaseLease,
        });
        await tx
          .updateTable('publishIntents')
          .set({ status: 'failed', endedAt: now, endReason: result.code })
          .where('id', '=', intentId)
          .where('status', '=', 'active')
          .execute();
        await tx
          .updateTable('slotReservations')
          .set({ status: 'released', releasedAt: now, releaseReason: 'rejected' })
          .where('intentId', '=', intentId)
          .where('status', '=', 'active')
          .execute();
        await audit('publish.rejected', { code: result.code, message: result.message, phase });
        return { kind: 'step', result: 'rejected', phase };
      }
      case 'rate_limited':
      case 'retryable': {
        await tx
          .updateTable('publishAttempts')
          .set({
            ...attemptUpdate,
            status: result.kind === 'rate_limited' ? 'rate_limited' : 'retryable_error',
            ...(result.kind === 'rate_limited'
              ? { retryAfter: new Date(now.getTime() + result.retryAfterSeconds * 1000) }
              : {}),
          })
          .where('id', '=', claimed.attemptId)
          .execute();
        const recent = await tx
          .selectFrom('publishAttempts')
          .select(['status'])
          .where('postDestinationId', '=', postDestinationId)
          .where('intentId', '=', intentId)
          .orderBy('startedAt', 'desc')
          .limit(maxRetries + 1)
          .execute();
        let consecutive = 0;
        for (const r of recent) {
          if (r.status === 'retryable_error' || r.status === 'rate_limited') consecutive++;
          else break;
        }
        if (consecutive > maxRetries) {
          await transitionDestination(tx, {
            postDestinationId,
            from: state,
            trigger: 'retries_exhausted',
            reason: result.code,
            now,
            set: releaseLease,
          });
          await audit('publish.failed', { code: result.code, attempts: consecutive, phase });
          return { kind: 'step', result: result.kind, phase };
        }
        await tx
          .updateTable('postDestinations')
          .set({ ...releaseLease, version: sql`version + 1` })
          .where('id', '=', postDestinationId)
          .execute();
        const baseDelay =
          result.kind === 'rate_limited'
            ? result.retryAfterSeconds * 1000
            : Math.min(5 * 60_000, 2000 * 2 ** (consecutive - 1));
        const jitter = 0.8 + Math.random() * 0.4;
        await next(new Date(now.getTime() + Math.round(baseDelay * jitter)));
        return { kind: 'step', result: result.kind, phase };
      }
      case 'unknown': {
        await tx
          .updateTable('publishAttempts')
          .set({ ...attemptUpdate, status: 'unknown' })
          .where('id', '=', claimed.attemptId)
          .execute();
        await transitionDestination(tx, {
          postDestinationId,
          from: state,
          trigger: 'unknown_outcome',
          reason: result.code,
          now,
          set: releaseLease,
        });
        await enqueue(
          tx,
          'publish.reconcile',
          { workspaceId, postDestinationId, intentId, correlationId: payload.correlationId },
          { jobKey: `reconcile:${postDestinationId}` },
        );
        await audit('publish.outcome_unknown', { code: result.code, phase });
        return { kind: 'step', result: 'unknown', phase };
      }
    }
  });
}

/** Persist a confirmed publication and its follow-ups (shared by advance, reconcile, operator link). */
export async function recordPublication(
  tx: Tx,
  ctx: ServiceContext,
  input: {
    workspaceId: string;
    postDestinationId: string;
    intentId: string;
    state: DestinationState;
    account: ConnectedAccount;
    externalId: string;
    containerId: string | null;
    permalink: string | null;
    visibility: string;
    publishedAt: Date;
    plannedAt: Date;
    format: 'video' | 'image' | 'carousel';
    linkMethod: 'provider_confirmed' | 'operator_linked' | 'reconciled';
    trigger: 'confirmed' | 'link_external';
    linkedBy?: { userId: string; label: string; reason: string };
    pageId: string;
    postId: string;
    correlationId?: string | null;
  },
): Promise<string> {
  const now = ctx.clock.now();
  const publicationId = ctx.ids.next();
  await tx
    .insertInto('externalPublications')
    .values({
      id: publicationId,
      workspaceId: input.workspaceId,
      postDestinationId: input.postDestinationId,
      intentId: input.intentId,
      socialAccountId: input.account.socialAccountId,
      provider: input.account.provider,
      connectionMode: input.account.connectionMode,
      providerAccountId: input.account.providerAccountId,
      externalId: input.externalId,
      externalContainerId: input.containerId,
      permalink: input.permalink,
      visibility: input.visibility,
      format: input.format,
      plannedAt: input.plannedAt,
      publishedAt: input.publishedAt,
      confirmedAt: now,
      linkMethod: input.linkMethod,
      linkedBy: input.linkedBy?.userId ?? null,
      linkReason: input.linkedBy?.reason ?? null,
    })
    .execute();
  await transitionDestination(tx, {
    postDestinationId: input.postDestinationId,
    from: input.state,
    trigger: input.trigger,
    now,
    set: {
      leaseOwner: null,
      leaseExpiresAt: null,
      checkpointPhase: 'confirm',
      checkpointProviderPostId: input.externalId,
      checkpointNextCheckAt: null,
    },
  });
  await tx
    .updateTable('publishIntents')
    .set({ status: 'completed', endedAt: now, endReason: 'published' })
    .where('id', '=', input.intentId)
    .where('status', '=', 'active')
    .execute();
  // The reservation becomes history (still counts for pacing) at the planned slot.
  await tx
    .updateTable('slotReservations')
    .set({ status: 'consumed' })
    .where('intentId', '=', input.intentId)
    .where('status', '=', 'active')
    .execute();
  // Metric observations at comparable ages, plus an early "latest" snapshot.
  await enqueue(
    tx,
    'metrics.refresh',
    { workspaceId: input.workspaceId, externalPublicationId: publicationId, ageBucket: null },
    { runAt: new Date(now.getTime() + 15_000), jobKey: `metrics:${publicationId}:latest` },
  );
  for (const bucket of AGE_BUCKETS) {
    await enqueue(
      tx,
      'metrics.refresh',
      {
        workspaceId: input.workspaceId,
        externalPublicationId: publicationId,
        ageBucket: bucket.key,
      },
      {
        runAt: new Date(input.publishedAt.getTime() + bucket.hours * 3600_000),
        jobKey: `metrics:${publicationId}:${bucket.key}`,
      },
    );
  }
  await appendAudit(tx, ctx.ids, {
    workspaceId: input.workspaceId,
    actor: input.linkedBy
      ? { type: 'user', userId: input.linkedBy.userId, label: input.linkedBy.label }
      : SERVICE_ACTORS.publisher,
    action:
      input.linkMethod === 'operator_linked'
        ? 'publication.linked'
        : input.linkMethod === 'reconciled'
          ? 'publication.reconciled'
          : 'publication.confirmed',
    entityType: 'post_destination',
    entityId: input.postDestinationId,
    pageId: input.pageId,
    postId: input.postId,
    data: {
      publicationId,
      externalId: input.externalId,
      visibility: input.visibility,
      publishedAt: input.publishedAt.toISOString(),
      plannedAt: input.plannedAt.toISOString(),
      connectionMode: input.account.connectionMode,
      simulated: input.account.connectionMode === 'simulated',
    },
    correlationId: input.correlationId ?? null,
  });
  return publicationId;
}

/**
 * publish.reconcile — resolve an unknown outcome through the provider's authoritative lookup.
 * Never resends unless the provider proves the operation did not take effect, and never
 * matches by title or caption.
 */
export async function reconcilePublish(
  ctx: ServiceContext,
  payload: TaskPayload<'publish.reconcile'>,
  options: AdvanceOptions,
): Promise<string> {
  const { workspaceId, postDestinationId, intentId } = payload;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const claim = await withTenant(ctx.db, { workspaceId }, async (tx) => {
    const now = ctx.clock.now();
    const refs = await destinationRefs(tx, postDestinationId);
    if (!refs) return null;
    const accountRow = await tx
      .selectFrom('socialAccounts')
      .selectAll()
      .where('id', '=', refs.socialAccountId)
      .forShare()
      .executeTakeFirstOrThrow();
    const pd = await tx
      .selectFrom('postDestinations')
      .selectAll()
      .where('id', '=', postDestinationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (pd.state !== 'needs_reconciliation' || pd.activeIntentId !== intentId) return null;
    if (
      pd.leaseOwner &&
      pd.leaseExpiresAt &&
      pd.leaseExpiresAt > now &&
      pd.leaseOwner !== options.workerId
    )
      return null;
    const intent = await tx
      .selectFrom('publishIntents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    const grant = await tx
      .selectFrom('providerGrants')
      .select(['grantedScopes'])
      .where('id', '=', accountRow.grantId)
      .executeTakeFirstOrThrow();
    const account = toConnectedAccount(accountRow, grant.grantedScopes);
    const adapter = ctx.registry.publishing(account.provider, account.connectionMode);
    if (!adapter) return null;
    const token = pd.leaseToken + 1;
    await tx
      .updateTable('postDestinations')
      .set({
        leaseOwner: options.workerId,
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      })
      .where('id', '=', postDestinationId)
      .execute();
    const { built, media } = await loadIntentForAdapter(tx, ctx, {
      workspaceId,
      postId: refs.postId,
      postDestinationId,
      revisionId: intent.revisionId,
      at: now,
    });
    return {
      token,
      account,
      adapter,
      refs,
      plannedAt: intent.plannedAt,
      checkpoint: {
        phase: (pd.checkpointPhase as PublishPhase | null) ?? 'prepare',
        ...(pd.checkpointReceiptId ? { receiptId: pd.checkpointReceiptId } : {}),
      } as PublishCheckpoint,
      intent: {
        intentId,
        intentVersion: intent.intentVersion,
        operationKey: intent.operationKey,
        plannedAt: intent.plannedAt.toISOString(),
        payload: built.payload,
        media,
      } satisfies PublishIntent,
    };
  });
  if (!claim) return 'skipped';

  const result = await claim.adapter.reconcile({
    account: claim.account,
    intent: claim.intent,
    checkpoint: claim.checkpoint,
    operationId: `${claim.intent.operationKey}:reconcile`,
  });

  return withTenant(ctx.db, { workspaceId }, async (tx) => {
    const now = ctx.clock.now();
    const pd = await tx
      .selectFrom('postDestinations')
      .selectAll()
      .where('id', '=', postDestinationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      pd.leaseToken !== claim.token ||
      pd.leaseOwner !== options.workerId ||
      pd.state !== 'needs_reconciliation'
    )
      return 'lost_lease';
    const release = { leaseOwner: null, leaseExpiresAt: null };
    const audit = (action: string, data: Record<string, unknown>) =>
      appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.publisher,
        action,
        entityType: 'post_destination',
        entityId: postDestinationId,
        pageId: claim.refs.pageId,
        postId: claim.refs.postId,
        data,
        correlationId: payload.correlationId ?? null,
      });
    switch (result.kind) {
      case 'published':
        await recordPublication(tx, ctx, {
          workspaceId,
          postDestinationId,
          intentId,
          state: 'needs_reconciliation',
          account: claim.account,
          externalId: result.providerPostId,
          containerId: result.containerId ?? null,
          permalink: result.permalink ?? null,
          visibility: result.visibility,
          publishedAt: new Date(result.publishedAt),
          plannedAt: claim.plannedAt,
          format:
            claim.intent.media.length > 1 ? 'carousel' : (claim.intent.media[0]?.kind ?? 'video'),
          linkMethod: 'reconciled',
          trigger: 'confirmed',
          pageId: claim.refs.pageId,
          postId: claim.refs.postId,
          correlationId: payload.correlationId ?? null,
        });
        return 'published';
      case 'processing': {
        const preDispatch = result.checkpoint.phase !== 'confirm';
        await transitionDestination(tx, {
          postDestinationId,
          from: 'needs_reconciliation',
          trigger: preDispatch ? 'reconciled_not_sent' : 'reconciled_processing',
          now,
          set: {
            ...release,
            checkpointPhase: result.checkpoint.phase,
            checkpointReceiptId: result.checkpoint.receiptId ?? null,
          },
        });
        await enqueue(
          tx,
          'publish.advance',
          {
            workspaceId,
            postDestinationId,
            intentId,
            intentVersion: claim.intent.intentVersion,
            correlationId: payload.correlationId,
          },
          { jobKey: `publish:${postDestinationId}` },
        );
        await audit('publish.reconciled_resume', { resumeFrom: result.checkpoint.phase });
        return 'resumed';
      }
      case 'not_found':
        // Proven not to exist: safe to resume from the last verified checkpoint.
        await transitionDestination(tx, {
          postDestinationId,
          from: 'needs_reconciliation',
          trigger: 'reconciled_not_sent',
          now,
          set: release,
        });
        await enqueue(
          tx,
          'publish.advance',
          {
            workspaceId,
            postDestinationId,
            intentId,
            intentVersion: claim.intent.intentVersion,
            correlationId: payload.correlationId,
          },
          { jobKey: `publish:${postDestinationId}` },
        );
        await audit('publish.reconciled_not_sent', { proof: result.proof });
        return 'not_sent';
      case 'indeterminate':
        await tx
          .updateTable('postDestinations')
          .set({ ...release, stateReason: 'operator_review_required' })
          .where('id', '=', postDestinationId)
          .execute();
        await audit('publish.reconciliation_required', { reason: result.reason });
        return 'indeterminate';
    }
  });
}
