import { sql, type Tx } from '@relay/db';
import { AppError } from '@relay/domain';
import { authorize, inWorkspace, type AuthenticatedUser } from './access';
import type { ServiceContext } from './context';

/**
 * Durable, user-facing job status (GET /jobs/:id). Graphile Worker deletes finished jobs, so
 * Relay keeps its own record; entity state (asset status, destination state) stays the
 * authoritative answer and this row adds progress and error codes.
 */

export async function createJobRun(
  tx: Tx,
  ctx: Pick<ServiceContext, 'ids'>,
  input: {
    workspaceId: string;
    kind: string;
    entityType: string;
    entityId: string;
    correlationId?: string | null;
  },
): Promise<string> {
  const id = ctx.ids.next();
  await tx
    .insertInto('jobRuns')
    .values({
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: input.correlationId ?? null,
    })
    .execute();
  return id;
}

export async function updateJobRun(
  tx: Tx,
  input: {
    entityType: string;
    entityId: string;
    kind: string;
    status: 'running' | 'succeeded' | 'failed';
    progress?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const latest = await tx
    .selectFrom('jobRuns')
    .select('id')
    .where('entityType', '=', input.entityType)
    .where('entityId', '=', input.entityId)
    .where('kind', '=', input.kind)
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
  if (!latest) return;
  await tx
    .updateTable('jobRuns')
    .set({
      status: input.status,
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.status === 'running'
        ? { startedAt: sql`COALESCE(started_at, now())`, attempts: sql`attempts + 1` }
        : {}),
      ...(input.status !== 'running' ? { finishedAt: new Date() } : {}),
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage?.slice(0, 500) ?? null,
    })
    .where('id', '=', latest.id)
    .execute();
}

export async function getJobRun(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  jobId: string,
) {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    authorize(member, 'jobs.view');
    const job = await tx
      .selectFrom('jobRuns')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!job) throw new AppError('not_found', 'Job not found');
    if (job.entityType === 'media_asset') {
      const asset = await tx
        .selectFrom('mediaAssets')
        .select(['pageId', 'status', 'rejectionCode', 'rejectionDetail'])
        .where('id', '=', job.entityId)
        .executeTakeFirst();
      if (!asset) throw new AppError('not_found', 'Job not found');
      authorize(member, 'media.view', asset.pageId);
      return {
        job,
        entity: {
          type: 'media_asset',
          id: job.entityId,
          status: asset.status,
          rejectionCode: asset.rejectionCode,
          rejectionDetail: asset.rejectionDetail,
        },
      };
    }
    return { job, entity: { type: job.entityType, id: job.entityId } };
  });
}
