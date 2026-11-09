import {
  AppError,
  approvalsSchema,
  canTransition,
  isAppError,
  submitPostSchema,
  type DestinationState,
} from '@relay/domain';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser } from './access';
import { appendAudit } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { transitionDestination, withSavepoint } from './destinations';
import { buildDestinationIntent, loadDestinationTargets, loadRevisionBundle } from './intents';

/**
 * Review. Submitting moves eligible destinations to needs_review; deciding binds an approval
 * to the complete normalised intent (hash), the revision, the actor, the time, the policy
 * revision and an optional approved time window. Batch requests return per-item outcomes.
 */

export interface ItemOutcome {
  postDestinationId: string;
  ok: boolean;
  state?: DestinationState;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function failure(postDestinationId: string, error: unknown): ItemOutcome {
  if (isAppError(error)) {
    return {
      postDestinationId,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  throw error;
}

export async function submitPost(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = submitPostSchema.parse(rawInput ?? {});
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const post = await tx
      .selectFrom('posts')
      .selectAll()
      .where('id', '=', postId)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
    if (!post || !post.currentRevisionId) throw new AppError('not_found', 'Post not found');
    authorize(member, 'content.submit', post.pageId);
    const bundle = await loadRevisionBundle(tx, post.currentRevisionId);
    const targets = await loadDestinationTargets(tx, postId);
    const now = ctx.clock.now();
    const outcomes: ItemOutcome[] = [];
    for (const target of targets) {
      if (input.postDestinationIds && !input.postDestinationIds.includes(target.postDestinationId))
        continue;
      const current = await tx
        .selectFrom('postDestinations')
        .select(['state'])
        .where('id', '=', target.postDestinationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const state = current.state as DestinationState;
      if (!canTransition(state, 'submit')) {
        if (!input.postDestinationIds) continue; // implicit "all": skip destinations past review
        outcomes.push(
          failure(
            target.postDestinationId,
            new AppError(
              'invalid_transition',
              `This destination is ${state} and cannot be submitted.`,
            ),
          ),
        );
        continue;
      }
      try {
        await withSavepoint(tx, async () => {
          const intent = await buildDestinationIntent(tx, ctx, {
            workspaceId,
            bundle,
            target,
            at: now,
          });
          const blocking = intent.issues.filter((i) => i.blocks === 'submit');
          if (blocking.length > 0) {
            throw new AppError('destination_validation_failed', blocking[0]!.message, {
              details: { issues: blocking },
            });
          }
          if (state === 'approved') {
            // Re-requesting review is only meaningful when the approval went stale.
            const approval = await tx
              .selectFrom('approvals')
              .select(['id', 'intentHash'])
              .where('postDestinationId', '=', target.postDestinationId)
              .where('decision', '=', 'approved')
              .where('invalidatedAt', 'is', null)
              .executeTakeFirst();
            if (approval && approval.intentHash === intent.hash)
              throw new AppError(
                'invalid_transition',
                'This destination is already approved for the current content.',
              );
            if (approval)
              await tx
                .updateTable('approvals')
                .set({ invalidatedAt: now, invalidatedReason: 'intent_changed' })
                .where('id', '=', approval.id)
                .execute();
          }
          const { to } = await transitionDestination(tx, {
            postDestinationId: target.postDestinationId,
            from: state,
            trigger: 'submit',
            now,
          });
          outcomes.push({ postDestinationId: target.postDestinationId, ok: true, state: to });
        });
      } catch (error) {
        outcomes.push(failure(target.postDestinationId, error));
      }
    }
    if (outcomes.some((o) => o.ok)) {
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: memberActor(member),
        action: 'post.submitted',
        entityType: 'post',
        entityId: postId,
        pageId: post.pageId,
        postId,
        data: {
          revisionId: post.currentRevisionId,
          submitted: outcomes.filter((o) => o.ok).map((o) => o.postDestinationId),
        },
        requestId: meta.requestId,
      });
    }
    return { outcomes };
  });
}

export async function decideApprovals(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  postId: string,
  rawInput: unknown,
  meta: RequestMeta,
) {
  const input = approvalsSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const post = await tx
      .selectFrom('posts')
      .selectAll()
      .where('id', '=', postId)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
    if (!post || !post.currentRevisionId) throw new AppError('not_found', 'Post not found');
    authorize(member, 'content.approve', post.pageId);
    const page = await tx
      .selectFrom('pages')
      .select(['currentPolicyRevision'])
      .where('id', '=', post.pageId)
      .executeTakeFirstOrThrow();
    const bundle = await loadRevisionBundle(tx, post.currentRevisionId);
    const targets = await loadDestinationTargets(tx, postId);
    const now = ctx.clock.now();
    const outcomes: ItemOutcome[] = [];
    for (const decision of input.decisions) {
      const target = targets.find((t) => t.postDestinationId === decision.postDestinationId);
      if (!target) {
        outcomes.push(
          failure(
            decision.postDestinationId,
            new AppError('not_found', 'Destination not found on this post'),
          ),
        );
        continue;
      }
      // Savepoint per item so one failure does not undo the others.
      try {
        await withSavepoint(tx, async () => {
          const current = await tx
            .selectFrom('postDestinations')
            .select(['state'])
            .where('id', '=', target.postDestinationId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const state = current.state as DestinationState;
          if (state !== 'needs_review')
            throw new AppError(
              'invalid_transition',
              `This destination is ${state}, not waiting for review.`,
            );
          if (decision.revisionId !== post.currentRevisionId) {
            throw new AppError(
              'version_conflict',
              'The post was edited after you opened it. Review the latest version.',
            );
          }
          const intent = await buildDestinationIntent(tx, ctx, {
            workspaceId,
            bundle,
            target,
            at: now,
          });
          if (intent.hash !== decision.intentHash) {
            throw new AppError(
              'version_conflict',
              'What this destination would publish changed after you opened it. Review it again.',
            );
          }
          if (decision.decision === 'approve') {
            const blocking = intent.issues.filter((i) => i.blocks === 'submit');
            if (blocking.length > 0)
              throw new AppError('destination_validation_failed', blocking[0]!.message, {
                details: { issues: blocking },
              });
            if (
              decision.windowStartsAt &&
              decision.windowEndsAt &&
              decision.windowStartsAt >= decision.windowEndsAt
            ) {
              throw new AppError(
                'validation_failed',
                'The approval window must end after it starts.',
              );
            }
          }
          const approvalId = ctx.ids.next();
          await tx
            .insertInto('approvals')
            .values({
              id: approvalId,
              workspaceId,
              postDestinationId: target.postDestinationId,
              revisionId: post.currentRevisionId,
              intentHash: intent.hash,
              decision: decision.decision === 'approve' ? 'approved' : 'rejected',
              note: decision.note ?? null,
              decidedBy: user.userId,
              decidedAt: now,
              policyRevision: page.currentPolicyRevision,
              windowStartsAt: decision.windowStartsAt ? new Date(decision.windowStartsAt) : null,
              windowEndsAt: decision.windowEndsAt ? new Date(decision.windowEndsAt) : null,
            })
            .execute();
          const { to } = await transitionDestination(tx, {
            postDestinationId: target.postDestinationId,
            from: state,
            trigger: decision.decision === 'approve' ? 'approve' : 'reject',
            reason: decision.decision === 'reject' ? 'changes_requested' : null,
            now,
          });
          await appendAudit(tx, ctx.ids, {
            workspaceId,
            actor: memberActor(member),
            action: decision.decision === 'approve' ? 'approval.approved' : 'approval.rejected',
            entityType: 'post_destination',
            entityId: target.postDestinationId,
            pageId: post.pageId,
            postId,
            data: {
              approvalId,
              revisionId: post.currentRevisionId,
              intentHash: intent.hash,
              window:
                decision.windowStartsAt || decision.windowEndsAt
                  ? {
                      startsAt: decision.windowStartsAt ?? null,
                      endsAt: decision.windowEndsAt ?? null,
                    }
                  : null,
              note: decision.note ? true : false,
            },
            requestId: meta.requestId,
          });
          outcomes.push({ postDestinationId: target.postDestinationId, ok: true, state: to });
        });
      } catch (error) {
        outcomes.push(failure(target.postDestinationId, error));
      }
    }
    return { outcomes };
  });
}
