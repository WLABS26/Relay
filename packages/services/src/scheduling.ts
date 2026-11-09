import { sql, type Tx } from '@relay/db';
import {
  AppError,
  evaluateSlot,
  lockSlotSchema,
  publishOperationKey,
  recommendSlots,
  recommendSlotsSchema,
  scheduleSchema,
  selectInstant,
  instantToZoned,
  versionedActionSchema,
  type DestinationState,
  type RecommendResult,
  type SlotContext,
  type WeekStart,
} from '@relay/domain';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser, type Member } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { destinationRefs, lockForScheduling, transitionDestination } from './destinations';
import { withIdempotency } from './idempotency';
import { buildDestinationIntent, loadDestinationTargets, loadRevisionBundle } from './intents';
import { loadRules } from './pages';
import { enqueue } from './tasks';

/**
 * Scheduling. Proposals (recommendations) never write; a schedule atomically persists the
 * immutable intent, the slot reservation, the audit event and the durable run-at job.
 *
 * Lock order (see docs/architecture/locking.md): social account → page → workspace →
 * post destination → intent/reservation rows. Schedule, cancel, dispatch claim, disconnect and
 * rights revocation all follow it, so they serialise without deadlocks.
 */

const ASAP_DELAY_MS = 5_000;
/** How long before the planned time the worker may start private preparation. */
const PREPARE_LEAD_MS = 2 * 60_000;
const PACING_WINDOW_MS = 9 * 24 * 3600_000;

async function pacingContext(
  tx: Tx,
  input: { socialAccountId: string; postDestinationId: string; around: Date },
): Promise<SlotContext['existing']> {
  const rows = await tx
    .selectFrom('slotReservations')
    .select(['postDestinationId', 'slotAt'])
    .where('socialAccountId', '=', input.socialAccountId)
    .where('status', 'in', ['active', 'consumed'])
    .where('slotAt', '>=', new Date(input.around.getTime() - PACING_WINDOW_MS))
    .where('slotAt', '<=', new Date(input.around.getTime() + PACING_WINDOW_MS))
    .execute();
  return rows.filter((r) => r.postDestinationId !== input.postDestinationId);
}

async function campaignFor(tx: Tx, postId: string) {
  return tx
    .selectFrom('posts as p')
    .leftJoin('campaigns as c', 'c.id', 'p.campaignId')
    .select(['c.startsOn', 'c.endsOn'])
    .where('p.id', '=', postId)
    .executeTakeFirst();
}

function violationError(violations: ReturnType<typeof evaluateSlot>['violations']): AppError {
  const first = violations[0]!;
  return new AppError(first.code, first.message, { details: { violations } });
}

export interface ScheduleResult {
  postDestinationId: string;
  intentId: string;
  intentVersion: number;
  plannedAt: string;
  civil: string;
  offset: string;
  zone: string;
  state: DestinationState;
  version: number;
  warnings: Array<{ code: string; message: string }>;
}

export async function scheduleDestination(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postDestinationId: string,
  rawInput: unknown,
  meta: RequestMeta & { idempotencyKey?: string | null },
) {
  const input = scheduleSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const refs = await destinationRefs(tx, postDestinationId);
    if (!refs || !refs.currentRevisionId) throw new AppError('not_found', 'Destination not found');
    authorize(member, 'content.schedule', refs.pageId);
    return withIdempotency(
      tx,
      {
        workspaceId,
        operation: 'post_destination.schedule',
        key: meta.idempotencyKey,
        actorUserId: user.userId,
        payload: { postDestinationId, ...input },
      },
      async () => {
        const result = await scheduleLocked(ctx, tx, member, {
          refs: { ...refs, currentRevisionId: refs.currentRevisionId! },
          input,
          meta,
        });
        return { status: 200, body: result };
      },
    );
  });
}

async function scheduleLocked(
  ctx: ServiceContext,
  tx: Tx,
  member: Member,
  args: {
    refs: {
      id: string;
      postId: string;
      pageId: string;
      socialAccountId: string;
      currentRevisionId: string;
    };
    input: ReturnType<typeof scheduleSchema.parse>;
    meta: RequestMeta;
  },
): Promise<ScheduleResult> {
  const { refs, input, meta } = args;
  const workspaceId = member.workspaceId;
  const now = ctx.clock.now();
  const { account, page, destination } = await lockForScheduling(tx, {
    socialAccountId: refs.socialAccountId,
    pageId: refs.pageId,
    postDestinationId: refs.id,
  });
  const workspace = await tx
    .selectFrom('workspaces')
    .select(['pauseGeneration'])
    .where('id', '=', workspaceId)
    .forShare()
    .executeTakeFirstOrThrow();

  if (destination.version !== input.expectedVersion) {
    throw new AppError(
      'version_conflict',
      'This destination changed since you loaded it. Reload and try again.',
    );
  }
  const state = destination.state as DestinationState;
  const rescheduling = ['scheduled', 'preparing', 'blocked', 'failed'].includes(state);
  if (!rescheduling && state !== 'approved') {
    throw new AppError(
      'approval_required',
      state === 'needs_review'
        ? 'Approve this destination before scheduling it.'
        : `A ${state} destination cannot be scheduled.`,
    );
  }
  if (account.status !== 'active')
    throw new AppError(
      'connection_unhealthy',
      `${account.displayName} needs to be reconnected before scheduling.`,
    );

  // The approval must still match what would be published right now.
  const approval = await tx
    .selectFrom('approvals')
    .selectAll()
    .where('postDestinationId', '=', refs.id)
    .where('decision', '=', 'approved')
    .where('invalidatedAt', 'is', null)
    .executeTakeFirst();
  if (!approval)
    throw new AppError('approval_required', 'This destination needs an approval first.');
  const bundle = await loadRevisionBundle(tx, refs.currentRevisionId);
  const target = (await loadDestinationTargets(tx, refs.postId)).find(
    (t) => t.postDestinationId === refs.id,
  )!;
  const built = await buildDestinationIntent(tx, ctx, { workspaceId, bundle, target, at: now });
  if (built.hash !== approval.intentHash || approval.revisionId !== refs.currentRevisionId) {
    throw new AppError(
      'approval_stale',
      'The content, media rights or target changed since approval. Request a new approval.',
    );
  }
  if (!built.mediaReady) throw new AppError('media_not_ready', 'Media is not ready yet.');
  const scheduleBlocker = built.issues.find((i) => i.blocks === 'schedule');
  if (scheduleBlocker) {
    throw new AppError('capability_unavailable', scheduleBlocker.message, {
      details: { reasonCode: scheduleBlocker.code, fallback: scheduleBlocker.fallback ?? null },
    });
  }
  const submitBlocker = built.issues.find((i) => i.blocks === 'submit');
  if (submitBlocker)
    throw new AppError('destination_validation_failed', submitBlocker.message, {
      details: { issues: built.issues },
    });

  // Resolve the planned instant in the page's zone.
  const { rules, revision: policyRevision } = await loadRules(tx, refs.pageId);
  const zone = page.timezone;
  const zoned =
    input.mode === 'asap'
      ? instantToZoned(new Date(now.getTime() + ASAP_DELAY_MS), zone)
      : selectInstant(input.localTime!, zone, input.offset, rules.ambiguousTimePolicy);
  const plannedAt = new Date(zoned.instant);

  const campaign = await campaignFor(tx, refs.postId);
  const evaluation = evaluateSlot(plannedAt, {
    zone,
    weekStart: page.weekStart as WeekStart,
    rules: input.mode === 'asap' ? { ...rules, leadMinutes: 0 } : rules,
    now,
    existing: await pacingContext(tx, {
      socialAccountId: account.id,
      postDestinationId: refs.id,
      around: plannedAt,
    }),
    excludePostDestinationId: refs.id,
    campaign: campaign ? { startsOn: campaign.startsOn, endsOn: campaign.endsOn } : null,
    rightsExpireAt: built.rights.expiresAt,
    approvalWindow:
      approval.windowStartsAt || approval.windowEndsAt
        ? { startsAt: approval.windowStartsAt, endsAt: approval.windowEndsAt }
        : null,
    asap: input.mode === 'asap',
  });
  if (evaluation.violations.length > 0) throw violationError(evaluation.violations);

  // Supersede the previous intent (reschedule) and release its reservation.
  const previous = destination.activeIntentId
    ? await tx
        .selectFrom('publishIntents')
        .selectAll()
        .where('id', '=', destination.activeIntentId)
        .executeTakeFirst()
    : null;
  if (previous) {
    const reservation = await tx
      .selectFrom('slotReservations')
      .select(['id', 'locked'])
      .where('intentId', '=', previous.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (reservation?.locked)
      throw new AppError('slot_locked', 'This slot is locked. Unlock it before moving the post.');
    await tx
      .updateTable('publishIntents')
      .set({ status: 'superseded', endedAt: now, endReason: 'rescheduled' })
      .where('id', '=', previous.id)
      .where('status', '=', 'active')
      .execute();
    await tx
      .updateTable('slotReservations')
      .set({ status: 'released', releasedAt: now, releaseReason: 'rescheduled' })
      .where('intentId', '=', previous.id)
      .where('status', '=', 'active')
      .execute();
  }

  const versionRow = await tx
    .selectFrom('publishIntents')
    .select(({ fn }) => fn.max('intentVersion').as('v'))
    .where('postDestinationId', '=', refs.id)
    .executeTakeFirst();
  const intentVersion = Number(versionRow?.v ?? 0) + 1;
  const intentId = ctx.ids.next();
  await tx
    .insertInto('publishIntents')
    .values({
      id: intentId,
      workspaceId,
      postDestinationId: refs.id,
      revisionId: refs.currentRevisionId,
      approvalId: approval.id,
      intentVersion,
      operationKey: publishOperationKey({
        workspaceId,
        postDestinationId: refs.id,
        revisionId: refs.currentRevisionId,
        intentVersion,
      }),
      intentHash: built.hash,
      dispatchMode: input.mode,
      plannedAt,
      civilLocal: zoned.civil,
      civilZone: zone,
      civilOffset: zoned.offset,
      pagePauseGeneration: page.pauseGeneration,
      workspacePauseGeneration: workspace.pauseGeneration,
      connectionGeneration: account.connectionGeneration,
      policyRevision,
      createdBy: member.userId,
    })
    .execute();
  try {
    await tx
      .insertInto('slotReservations')
      .values({
        id: ctx.ids.next(),
        workspaceId,
        socialAccountId: account.id,
        pageDestinationId: target.pageDestinationId,
        postDestinationId: refs.id,
        intentId,
        slotAt: plannedAt,
        locked: input.lockSlot,
      })
      .execute();
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'slot_reservations_exact_slot_key') {
      throw new AppError(
        'slot_conflict',
        'Another post was just scheduled on this account at exactly that time.',
      );
    }
    throw error;
  }
  const { to, version } = await transitionDestination(tx, {
    postDestinationId: refs.id,
    from: state,
    trigger: rescheduling ? 'reschedule' : 'schedule',
    now,
    set: {
      activeIntentId: intentId,
      checkpointPhase: null,
      checkpointReceiptId: null,
      checkpointProviderPostId: null,
      checkpointNextCheckAt: null,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  const runAt = new Date(Math.max(now.getTime(), plannedAt.getTime() - PREPARE_LEAD_MS));
  await enqueue(
    tx,
    'publish.advance',
    {
      workspaceId,
      postDestinationId: refs.id,
      intentId,
      intentVersion,
      correlationId: meta.requestId,
    },
    { runAt, jobKey: `publish:${refs.id}` },
  );
  await appendAudit(tx, ctx.ids, {
    workspaceId,
    actor: memberActor(member),
    action: rescheduling ? 'publish.rescheduled' : 'publish.scheduled',
    entityType: 'post_destination',
    entityId: refs.id,
    pageId: refs.pageId,
    postId: refs.postId,
    data: {
      intentId,
      intentVersion,
      plannedAt: plannedAt.toISOString(),
      local: zoned.civil,
      offset: zoned.offset,
      zone,
      mode: input.mode,
      locked: input.lockSlot,
      account: account.displayName,
      connectionMode: account.connectionMode,
      visibility: built.payload.visibility,
      previousIntentId: previous?.id ?? null,
    },
    requestId: meta.requestId,
  });
  return {
    postDestinationId: refs.id,
    intentId,
    intentVersion,
    plannedAt: plannedAt.toISOString(),
    civil: zoned.civil,
    offset: zoned.offset,
    zone,
    state: to,
    version,
    warnings: evaluation.warnings,
  };
}

/** Cancel the unclaimed intent and release its reservation; the approval stays valid. */
export async function unscheduleDestination(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postDestinationId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = versionedActionSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const refs = await destinationRefs(tx, postDestinationId);
    if (!refs) throw new AppError('not_found', 'Destination not found');
    authorize(member, 'content.cancel', refs.pageId);
    const { destination } = await lockForScheduling(tx, {
      socialAccountId: refs.socialAccountId,
      pageId: refs.pageId,
      postDestinationId,
    });
    if (destination.version !== input.expectedVersion)
      throw new AppError(
        'version_conflict',
        'This destination changed since you loaded it. Reload and try again.',
      );
    const state = destination.state as DestinationState;
    if (state === 'dispatching' || state === 'processing') {
      throw new AppError(
        'invalid_transition',
        'Relay already claimed this post for publishing; it can no longer be canceled. Its outcome will be shown here.',
      );
    }
    const now = ctx.clock.now();
    if (destination.activeIntentId) {
      await tx
        .updateTable('publishIntents')
        .set({ status: 'canceled', endedAt: now, endReason: 'unscheduled' })
        .where('id', '=', destination.activeIntentId)
        .where('status', '=', 'active')
        .execute();
      await tx
        .updateTable('slotReservations')
        .set({ status: 'released', releasedAt: now, releaseReason: 'unscheduled' })
        .where('intentId', '=', destination.activeIntentId)
        .where('status', '=', 'active')
        .execute();
    }
    const { to, version } = await transitionDestination(tx, {
      postDestinationId,
      from: state,
      trigger: 'unschedule',
      now,
      set: {
        activeIntentId: null,
        checkpointPhase: null,
        checkpointReceiptId: null,
        checkpointProviderPostId: null,
        checkpointNextCheckAt: null,
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'publish.unscheduled',
      entityType: 'post_destination',
      entityId: postDestinationId,
      pageId: refs.pageId,
      postId: refs.postId,
      data: { intentId: destination.activeIntentId, from: state },
      requestId: meta.requestId,
    });
    return { state: to, version };
  });
}

export async function setSlotLock(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postDestinationId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = lockSlotSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const refs = await destinationRefs(tx, postDestinationId);
    if (!refs) throw new AppError('not_found', 'Destination not found');
    authorize(member, 'content.schedule', refs.pageId);
    const { destination } = await lockForScheduling(tx, {
      socialAccountId: refs.socialAccountId,
      pageId: refs.pageId,
      postDestinationId,
    });
    if (destination.version !== input.expectedVersion)
      throw new AppError('version_conflict', 'This destination changed since you loaded it.');
    const updated = await tx
      .updateTable('slotReservations')
      .set({ locked: input.locked })
      .where('postDestinationId', '=', postDestinationId)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    if (!updated)
      throw new AppError('invalid_transition', 'Only scheduled posts have a slot to lock.');
    await tx
      .updateTable('postDestinations')
      .set({ version: sql`version + 1` })
      .where('id', '=', postDestinationId)
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: input.locked ? 'publish.slot_locked' : 'publish.slot_unlocked',
      entityType: 'post_destination',
      entityId: postDestinationId,
      pageId: refs.pageId,
      postId: refs.postId,
      requestId: meta.requestId,
    });
    return { locked: input.locked, version: destination.version + 1 };
  });
}

/** Operator retry of a failed destination: resumes the same intent from its last checkpoint. */
export async function retryDestination(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postDestinationId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = versionedActionSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const refs = await destinationRefs(tx, postDestinationId);
    if (!refs) throw new AppError('not_found', 'Destination not found');
    authorize(member, 'content.retry', refs.pageId);
    const { destination } = await lockForScheduling(tx, {
      socialAccountId: refs.socialAccountId,
      pageId: refs.pageId,
      postDestinationId,
    });
    if (destination.version !== input.expectedVersion)
      throw new AppError('version_conflict', 'This destination changed since you loaded it.');
    if (destination.state !== 'failed')
      throw new AppError('invalid_transition', 'Only failed destinations can be retried.');
    const intent = destination.activeIntentId
      ? await tx
          .selectFrom('publishIntents')
          .select(['id', 'intentVersion', 'status'])
          .where('id', '=', destination.activeIntentId)
          .executeTakeFirst()
      : null;
    if (!intent || intent.status !== 'active')
      throw new AppError(
        'invalid_transition',
        'This destination has no active publish intent; schedule it again.',
      );
    const now = ctx.clock.now();
    const { to, version } = await transitionDestination(tx, {
      postDestinationId,
      from: 'failed',
      trigger: 'retry',
      now,
    });
    await enqueue(
      tx,
      'publish.advance',
      {
        workspaceId,
        postDestinationId,
        intentId: intent.id,
        intentVersion: intent.intentVersion,
        correlationId: meta.requestId,
      },
      { jobKey: `publish:${postDestinationId}` },
    );
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'publish.retry_requested',
      entityType: 'post_destination',
      entityId: postDestinationId,
      pageId: refs.pageId,
      postId: refs.postId,
      data: { intentId: intent.id, resumeFrom: destination.checkpointPhase ?? 'prepare' },
      requestId: meta.requestId,
    });
    return { state: to, version };
  });
}

/** Slot proposals. Pure computation over committed state: nothing is reserved. */
export async function recommendSlotsFor(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
) {
  const input = recommendSlotsSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const now = ctx.clock.now();
    const results: Array<
      { postDestinationId: string; label: string; zone: string } & RecommendResult
    > = [];
    for (const id of input.postDestinationIds) {
      const refs = await destinationRefs(tx, id);
      if (!refs) throw new AppError('not_found', 'Destination not found');
      authorize(member, 'content.view', refs.pageId);
      const page = await tx
        .selectFrom('pages')
        .select(['timezone', 'weekStart'])
        .where('id', '=', refs.pageId)
        .executeTakeFirstOrThrow();
      const label = await tx
        .selectFrom('pageDestinations')
        .select('label')
        .innerJoin('postDestinations', 'postDestinations.pageDestinationId', 'pageDestinations.id')
        .where('postDestinations.id', '=', id)
        .executeTakeFirstOrThrow();
      const { rules } = await loadRules(tx, refs.pageId);
      const approval = await tx
        .selectFrom('approvals')
        .select(['windowStartsAt', 'windowEndsAt'])
        .where('postDestinationId', '=', id)
        .where('decision', '=', 'approved')
        .where('invalidatedAt', 'is', null)
        .executeTakeFirst();
      const campaign = await campaignFor(tx, refs.postId);
      const from = input.from ? new Date(input.from) : now;
      const result = recommendSlots({
        zone: page.timezone,
        weekStart: page.weekStart as WeekStart,
        rules,
        now,
        from,
        existing: await pacingContext(tx, {
          socialAccountId: refs.socialAccountId,
          postDestinationId: id,
          around: new Date(from.getTime() + (input.horizonDays * 86_400_000) / 2),
        }),
        excludePostDestinationId: id,
        campaign: campaign ? { startsOn: campaign.startsOn, endsOn: campaign.endsOn } : null,
        approvalWindow: approval
          ? { startsAt: approval.windowStartsAt, endsAt: approval.windowEndsAt }
          : null,
        count: input.count,
        horizonDays: input.horizonDays,
      });
      results.push({ postDestinationId: id, label: label.label, zone: page.timezone, ...result });
    }
    return { results };
  });
}
