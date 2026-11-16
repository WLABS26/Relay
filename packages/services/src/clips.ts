import { sql, type Tx } from '@relay/db';
import {
  AppError,
  can,
  CLIP_MIN_MS,
  clipCaptionCueSchema,
  clipGeometry,
  createClipSchema,
  createPostSchema,
  importCaptionsSchema,
  parseSrt,
  parseVtt,
  shiftCues,
  updateClipSchema,
  validateClipRange,
  validateCues,
  type ClipAspect,
  type ClipCaptionCue,
  type ClipCaptionStyle,
  type ClipCropMode,
  type ClipGeometry,
  type Cue,
} from '@relay/domain';
import { clipEditHash } from '@relay/domain/server';
import { z } from 'zod';
import {
  accessiblePageIds,
  authorize,
  inWorkspace,
  memberActor,
  requirePage,
  type AuthenticatedUser,
} from './access';
import { appendAudit } from './audit';
import { requireFinishedRender } from './clip-render';
import type { RequestMeta, ServiceContext } from './context';
import { withIdempotency } from './idempotency';
import { createPostIn } from './posts';
import { evaluateRights, RIGHTS_PROBLEM_LABELS } from './rights';

/**
 * Clip projects and their revisions: non-destructive editing of an uploaded recording.
 *
 * A clip project points at a source asset and at its current revision. Every save writes one
 * new immutable `clip_revisions` row (range, aspect, crop mode, captions) and moves the pointer;
 * nothing here writes the source asset or produces media. Rendering a revision into a derived
 * asset is a separate command.
 *
 * Times are milliseconds on the source's 0-based timeline, `startMs` inclusive and `endMs`
 * exclusive. Caption cues are stored on that same timeline, so a trim never rewrites them.
 */

const DEFAULT_ASPECT: ClipAspect = '9:16';
const DEFAULT_CROP_MODE: ClipCropMode = 'fill';
const CAPTION_STYLE: ClipCaptionStyle = 'default';
/** `clip_revisions.captions` is capped by `pg_column_size(captions) < 131072`. */
const CAPTIONS_MAX_STORED_BYTES = 128 * 1024;
const CAPTIONS_TOO_LARGE = 'These captions are too large to save (128 KiB at most).';
const LIST_LIMIT = 200;

export interface ClipProjectView {
  id: string;
  pageId: string;
  sourceAssetId: string;
  sourceAssetVersion: number;
  candidateId: string | null;
  title: string;
  currentRevisionId: string;
  /** Optimistic concurrency token: send it back with the next save. */
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClipRevisionView {
  id: string;
  clipId: string;
  revisionNumber: number;
  startMs: number;
  endMs: number;
  aspect: ClipAspect;
  cropMode: ClipCropMode;
  /** Cues on the source timeline; null means no captions. */
  captions: ClipCaptionCue[] | null;
  captionStyle: ClipCaptionStyle;
  editHash: string;
  createdBy: string;
  createdAt: Date;
}

export interface ClipSourceView {
  id: string;
  originalFilename: string;
  status: string;
  /** Display dimensions (after rotation). */
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasAudio: boolean | null;
  isSample: boolean;
}

export interface ClipRenderView {
  id: string;
  revisionId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  errorDetail: string | null;
  outputAssetId: string;
  /** Status of the derived asset; null if it is no longer visible. */
  outputAssetStatus: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ClipDetail {
  clip: ClipProjectView;
  revision: ClipRevisionView;
  source: ClipSourceView;
  /** The newest render of this clip, of whichever revision, or null if none was requested. */
  latestRender: ClipRenderView | null;
  /** Scale, crop and pad numbers for the current revision; null without source dimensions. */
  geometry: ClipGeometry | null;
}

export interface ClipSummary {
  id: string;
  pageId: string;
  sourceAssetId: string;
  candidateId: string | null;
  title: string;
  version: number;
  currentRevisionId: string;
  revisionNumber: number;
  startMs: number;
  endMs: number;
  aspect: ClipAspect;
  cropMode: ClipCropMode;
  hasCaptions: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateClipResponse {
  clipId: string;
  revisionId: string;
  version: number;
}

export interface UpdateClipResponse {
  clip: ClipProjectView;
  revision: ClipRevisionView;
  /** False when the save matched the current revision and no new one was written. */
  revisionCreated: boolean;
}

const listClipsSchema = z.strictObject({
  pageId: z.uuid().optional(),
  sourceAssetId: z.uuid().optional(),
});

const PROJECT_COLUMNS = [
  'id',
  'pageId',
  'sourceAssetId',
  'sourceAssetVersion',
  'candidateId',
  'title',
  'currentRevisionId',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

const REVISION_COLUMNS = [
  'id',
  'clipId',
  'revisionNumber',
  'startMs',
  'endMs',
  'aspect',
  'cropMode',
  'captions',
  'captionStyle',
  'editHash',
  'createdBy',
  'createdAt',
] as const;

const SOURCE_COLUMNS = [
  'id',
  'pageId',
  'kind',
  'status',
  'origin',
  'version',
  'originalFilename',
  'width',
  'height',
  'durationMs',
  'hasAudio',
  'isSample',
] as const;

function clipMaxMs(ctx: ServiceContext): number {
  return ctx.config.media.clipMaxSeconds * 1000;
}

async function loadProject(tx: Tx, clipId: string, lock: boolean) {
  const query = tx
    .selectFrom('clipProjects')
    .select(PROJECT_COLUMNS)
    .where('id', '=', clipId)
    .where('archivedAt', 'is', null);
  return (lock ? query.forUpdate() : query).executeTakeFirst();
}

type ProjectRow = NonNullable<Awaited<ReturnType<typeof loadProject>>>;

function toProjectView(row: ProjectRow): ClipProjectView {
  // Set in the transaction that inserts the project, so it is only null inside createClip.
  if (!row.currentRevisionId) throw new Error(`clip ${row.id} has no current revision`);
  return { ...row, currentRevisionId: row.currentRevisionId };
}

async function loadRevision(tx: Tx, revisionId: string): Promise<ClipRevisionView> {
  const row = await tx
    .selectFrom('clipRevisions')
    .select(REVISION_COLUMNS)
    .where('id', '=', revisionId)
    .executeTakeFirstOrThrow();
  return {
    ...row,
    aspect: row.aspect as ClipAspect,
    cropMode: row.cropMode as ClipCropMode,
    captions: row.captions as ClipCaptionCue[] | null,
    captionStyle: row.captionStyle as ClipCaptionStyle,
  };
}

async function loadSource(tx: Tx, assetId: string) {
  return tx
    .selectFrom('mediaAssets')
    .select(SOURCE_COLUMNS)
    .where('id', '=', assetId)
    .executeTakeFirst();
}

type SourceRow = NonNullable<Awaited<ReturnType<typeof loadSource>>>;

/** The checks that make an asset usable as the source of a clip; returns its duration. */
function requireClippableSource(source: SourceRow): number {
  if (source.kind !== 'video')
    throw new AppError('validation_failed', 'Only videos can be clipped.', {
      fieldErrors: { sourceAssetId: ['Choose a video'] },
    });
  if (source.origin === 'render')
    throw new AppError('validation_failed', 'A rendered clip cannot be clipped again.', {
      fieldErrors: { sourceAssetId: ['Choose an uploaded video, not a rendered clip'] },
    });
  if (source.status !== 'ready' || !source.durationMs)
    throw new AppError('media_not_ready', 'This media is still being validated or was rejected.');
  return source.durationMs;
}

async function requireEditRights(tx: Tx, ctx: ServiceContext, assetId: string): Promise<void> {
  const rights = await evaluateRights(tx, {
    assetIds: [assetId],
    operation: 'edit',
    at: ctx.clock.now(),
  });
  if (rights.ok) return;
  const reason = rights.problems[0]?.reason ?? 'no_grant';
  throw new AppError(
    'rights_missing',
    reason === 'operation_denied'
      ? 'The recorded rights do not allow editing this media.'
      : RIGHTS_PROBLEM_LABELS[reason],
    { details: { problems: rights.problems } },
  );
}

/** Validate a range against the source, or throw `validation_failed` with field errors. */
function requireRange(
  ctx: ServiceContext,
  range: { startMs: number; endMs: number },
  sourceDurationMs: number,
  /** Report every error under this field instead (a range that came from a candidate). */
  field?: string,
): void {
  const result = validateClipRange({
    ...range,
    sourceDurationMs,
    minMs: CLIP_MIN_MS,
    maxMs: clipMaxMs(ctx),
  });
  if (result.ok) return;
  const fieldErrors = field
    ? { [field]: Object.values(result.fieldErrors).flat() }
    : result.fieldErrors;
  throw new AppError('validation_failed', 'This range cannot be used for a clip.', {
    fieldErrors,
  });
}

function sourceView(source: SourceRow): ClipSourceView {
  return {
    id: source.id,
    originalFilename: source.originalFilename,
    status: source.status,
    width: source.width,
    height: source.height,
    durationMs: source.durationMs,
    hasAudio: source.hasAudio,
    isSample: source.isSample,
  };
}

function defaultTitle(filename: string): string {
  return `Clip of ${filename}`.slice(0, 120).trim();
}

/**
 * Start a clip from a suggested candidate or from an explicit range. Writes the project and its
 * first revision (9:16, fill, no captions); the source is only read.
 */
export async function createClip(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta & { idempotencyKey?: string | null },
) {
  const input = createClipSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const source = await loadSource(tx, input.sourceAssetId);
    if (!source || source.status === 'deleted') throw new AppError('not_found', 'Media not found');
    authorize(member, 'content.create', source.pageId);
    await requirePage(tx, member, source.pageId);
    return withIdempotency<CreateClipResponse>(
      tx,
      {
        workspaceId,
        operation: 'clips.create',
        key: meta.idempotencyKey,
        actorUserId: user.userId,
        payload: input,
      },
      async () => {
        const durationMs = requireClippableSource(source);
        await requireEditRights(tx, ctx, source.id);

        let range: { startMs: number; endMs: number };
        if (input.candidateId !== undefined) {
          const candidate = await tx
            .selectFrom('clipCandidates as k')
            .innerJoin('mediaAnalyses as m', 'm.id', 'k.analysisId')
            .select(['k.id', 'k.assetId', 'k.startMs', 'k.endMs', 'm.assetVersion'])
            .where('k.id', '=', input.candidateId)
            .executeTakeFirst();
          if (!candidate || candidate.assetId !== source.id)
            throw new AppError('validation_failed', 'That suggestion is not for this video.', {
              fieldErrors: { candidateId: ['Unknown suggestion'] },
            });
          // A suggestion's times are on the timeline of the bytes that were analysed.
          if (candidate.assetVersion !== source.version)
            throw new AppError(
              'validation_failed',
              'That suggestion was made for an earlier version of this video.',
              { fieldErrors: { candidateId: ['Analyse the video again'] } },
            );
          range = { startMs: candidate.startMs, endMs: candidate.endMs };
          requireRange(ctx, range, durationMs, 'candidateId');
        } else {
          // The schema guarantees both ends when there is no candidate.
          range = { startMs: input.startMs!, endMs: input.endMs! };
          requireRange(ctx, range, durationMs);
        }

        const clipId = ctx.ids.next();
        const revisionId = ctx.ids.next();
        const title = input.title ?? defaultTitle(source.originalFilename);
        await tx
          .insertInto('clipProjects')
          .values({
            id: clipId,
            workspaceId,
            pageId: source.pageId,
            sourceAssetId: source.id,
            sourceAssetVersion: source.version,
            candidateId: input.candidateId ?? null,
            title,
            createdBy: user.userId,
          })
          .execute();
        await tx
          .insertInto('clipRevisions')
          .values({
            id: revisionId,
            workspaceId,
            clipId,
            revisionNumber: 1,
            startMs: range.startMs,
            endMs: range.endMs,
            aspect: DEFAULT_ASPECT,
            cropMode: DEFAULT_CROP_MODE,
            captions: null,
            captionStyle: CAPTION_STYLE,
            editHash: clipEditHash({
              ...range,
              aspect: DEFAULT_ASPECT,
              cropMode: DEFAULT_CROP_MODE,
              captions: null,
              captionStyle: CAPTION_STYLE,
            }),
            createdBy: user.userId,
          })
          .execute();
        await tx
          .updateTable('clipProjects')
          .set({ currentRevisionId: revisionId })
          .where('id', '=', clipId)
          .execute();
        if (input.candidateId !== undefined) {
          // Making a clip from a suggestion is the reviewer's verdict on it.
          await tx
            .updateTable('clipCandidates')
            .set({ feedback: 'accepted', feedbackBy: user.userId, feedbackAt: ctx.clock.now() })
            .where('id', '=', input.candidateId)
            .execute();
        }
        await appendAudit(tx, ctx.ids, {
          workspaceId,
          actor: memberActor(member),
          action: 'clip.created',
          entityType: 'clip_project',
          entityId: clipId,
          pageId: source.pageId,
          data: {
            revisionId,
            sourceAssetId: source.id,
            candidateId: input.candidateId ?? null,
            startMs: range.startMs,
            endMs: range.endMs,
          },
          requestId: meta.requestId,
        });
        return { status: 201, body: { clipId, revisionId, version: 1 } };
      },
    );
  });
}

/**
 * Save the editor's state as a new immutable revision. The request replaces the whole editable
 * state; a save that renders the same picture as the current revision writes nothing new.
 */
export async function updateClip(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  clipId: string,
  rawInput: unknown,
  meta: RequestMeta,
): Promise<UpdateClipResponse> {
  const input = updateClipSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const project = await loadProject(tx, clipId, true);
    if (!project) throw new AppError('not_found', 'Clip not found');
    authorize(member, 'content.edit', project.pageId);
    if (project.version !== input.version) {
      throw new AppError(
        'version_conflict',
        'Someone else edited this clip. Reload to see their changes.',
      );
    }
    const source = await loadSource(tx, project.sourceAssetId);
    if (!source || source.status === 'deleted') throw new AppError('not_found', 'Clip not found');
    const durationMs = requireClippableSource(source);
    await requireEditRights(tx, ctx, source.id);
    requireRange(ctx, input, durationMs);

    let captions: Cue[] | null = null;
    if (input.captions && input.captions.length > 0) {
      const checked = validateCues(input.captions, {
        clipStartMs: input.startMs,
        clipEndMs: input.endMs,
      });
      if (!checked.ok)
        throw new AppError('validation_failed', 'Some captions need fixing.', {
          fieldErrors: checked.fieldErrors,
        });
      captions = checked.cues;
      await requireCaptionsFit(tx, captions);
    }

    const current = await loadRevision(tx, toProjectView(project).currentRevisionId);
    const editHash = clipEditHash({
      startMs: input.startMs,
      endMs: input.endMs,
      aspect: input.aspect,
      cropMode: input.cropMode,
      captions,
      captionStyle: CAPTION_STYLE,
    });
    const title = input.title ?? project.title;
    const sameEdit = editHash === current.editHash;
    if (sameEdit && title === project.title) {
      return { clip: toProjectView(project), revision: current, revisionCreated: false };
    }

    let revisionId = current.id;
    if (!sameEdit) {
      const latest = await tx
        .selectFrom('clipRevisions')
        .select(({ fn }) => fn.max('revisionNumber').as('n'))
        .where('clipId', '=', clipId)
        .executeTakeFirstOrThrow();
      revisionId = ctx.ids.next();
      await tx
        .insertInto('clipRevisions')
        .values({
          id: revisionId,
          workspaceId,
          clipId,
          revisionNumber: Number(latest.n ?? 0) + 1,
          startMs: input.startMs,
          endMs: input.endMs,
          aspect: input.aspect,
          cropMode: input.cropMode,
          captions: captions ? JSON.stringify(captions) : null,
          captionStyle: CAPTION_STYLE,
          editHash,
          createdBy: user.userId,
        })
        .execute();
    }
    await tx
      .updateTable('clipProjects')
      .set({ currentRevisionId: revisionId, title, version: project.version + 1 })
      .where('id', '=', clipId)
      .where('version', '=', project.version)
      .execute();

    if (!sameEdit && project.candidateId) {
      const candidate = await tx
        .selectFrom('clipCandidates')
        .select(['id', 'startMs', 'endMs', 'feedback'])
        .where('id', '=', project.candidateId)
        .executeTakeFirst();
      // Only the verdict this clip gave is replaced; a reviewer's explicit one (wrong fit,
      // rights issue) says more than "the trim was adjusted" and is kept.
      if (
        candidate &&
        (candidate.startMs !== input.startMs || candidate.endMs !== input.endMs) &&
        (candidate.feedback === null || candidate.feedback === 'accepted')
      ) {
        await tx
          .updateTable('clipCandidates')
          .set({ feedback: 'trim_adjusted', feedbackBy: user.userId, feedbackAt: ctx.clock.now() })
          .where('id', '=', candidate.id)
          .execute();
      }
    }

    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: sameEdit ? 'clip.renamed' : 'clip.updated',
      entityType: 'clip_project',
      entityId: clipId,
      pageId: project.pageId,
      data: sameEdit
        ? { revisionId }
        : {
            revisionId,
            startMs: input.startMs,
            endMs: input.endMs,
            aspect: input.aspect,
            cropMode: input.cropMode,
            cues: captions?.length ?? 0,
          },
      requestId: meta.requestId,
    });
    const updated = await loadProject(tx, clipId, false);
    return {
      clip: toProjectView(updated!),
      revision: sameEdit ? current : await loadRevision(tx, revisionId),
      revisionCreated: !sameEdit,
    };
  });
}

/**
 * Refuse captions the revision row could not hold. The column's CHECK measures the stored
 * jsonb, which for short cues is larger than the JSON text, so the database does the measuring
 * here too and the user gets a field error instead of a failed insert.
 */
async function requireCaptionsFit(tx: Tx, captions: readonly Cue[]): Promise<void> {
  const measured = await sql<{ bytes: number }>`
    SELECT pg_column_size(${JSON.stringify(captions)}::jsonb) AS bytes`.execute(tx);
  if ((measured.rows[0]?.bytes ?? 0) >= CAPTIONS_MAX_STORED_BYTES) {
    throw new AppError('payload_too_large', CAPTIONS_TOO_LARGE, {
      fieldErrors: { captions: [CAPTIONS_TOO_LARGE] },
    });
  }
}

/**
 * Turn an uploaded SRT or WebVTT file into validated cues for the editor. Nothing is stored:
 * the editor shows the cues and saves them through `updateClip`.
 */
export async function importCaptions(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  clipId: string,
  rawInput: unknown,
): Promise<{ cues: Cue[] }> {
  const input = importCaptionsSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const project = await loadProject(tx, clipId, false);
    if (!project) throw new AppError('not_found', 'Clip not found');
    authorize(member, 'content.edit', project.pageId);
    const revision = await loadRevision(tx, toProjectView(project).currentRevisionId);

    const parsed = input.format === 'srt' ? parseSrt(input.text) : parseVtt(input.text);
    const onSource = input.relativeTo === 'clip' ? shiftCues(parsed, revision.startMs) : parsed;
    // Same shape check a save applies, so nothing is handed to the editor that it cannot save.
    const shaped = z.array(clipCaptionCueSchema).max(500).safeParse(onSource);
    if (!shaped.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of shaped.error.issues) {
        (fieldErrors[['captions', ...issue.path].join('.')] ??= []).push(issue.message);
      }
      throw new AppError('validation_failed', 'This caption file cannot be imported.', {
        fieldErrors,
      });
    }
    const checked = validateCues(shaped.data, {
      clipStartMs: revision.startMs,
      clipEndMs: revision.endMs,
    });
    if (!checked.ok)
      throw new AppError('validation_failed', 'This caption file cannot be imported.', {
        fieldErrors: checked.fieldErrors,
      });
    return { cues: checked.cues };
  });
}

export async function getClip(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  clipId: string,
): Promise<ClipDetail> {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const project = await loadProject(tx, clipId, false);
    if (!project) throw new AppError('not_found', 'Clip not found');
    authorize(member, 'content.view', project.pageId);
    const clip = toProjectView(project);
    const revision = await loadRevision(tx, clip.currentRevisionId);
    const source = await loadSource(tx, project.sourceAssetId);
    if (!source) throw new AppError('not_found', 'Clip not found');

    const render = await tx
      .selectFrom('renderJobs as r')
      .leftJoin('mediaAssets as a', 'a.id', 'r.outputAssetId')
      .select([
        'r.id',
        'r.revisionId',
        'r.status',
        'r.errorCode',
        'r.errorDetail',
        'r.outputAssetId',
        'a.status as outputAssetStatus',
        'r.createdAt',
        'r.finishedAt',
      ])
      .where('r.clipId', '=', clipId)
      // IDs are UUIDv7 and break ties between jobs created in the same instant.
      .orderBy('r.createdAt', 'desc')
      .orderBy('r.id', 'desc')
      .executeTakeFirst();

    const geometry =
      source.width && source.height && source.width >= 2 && source.height >= 2
        ? clipGeometry({
            sourceWidth: source.width,
            sourceHeight: source.height,
            aspect: revision.aspect,
            cropMode: revision.cropMode,
          })
        : null;
    return {
      clip,
      revision,
      source: sourceView(source),
      latestRender: render
        ? { ...render, status: render.status as ClipRenderView['status'] }
        : null,
      geometry,
    };
  });
}

/** Clips the member may see, newest first, optionally for one page or one source asset. */
export async function listClips(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawFilter: unknown = {},
): Promise<{ clips: ClipSummary[] }> {
  const filter = listClipsSchema.parse(rawFilter);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    if (filter.pageId) {
      authorize(member, 'content.view', filter.pageId);
    } else if (!can(member.role, 'content.view')) {
      throw new AppError('forbidden', `Your role (${member.role}) cannot do this.`, {
        details: { action: 'content.view' },
      });
    }
    const pageIds = accessiblePageIds(member);
    if (pageIds !== null && pageIds.length === 0) return { clips: [] };

    let query = tx
      .selectFrom('clipProjects as p')
      .innerJoin('clipRevisions as r', 'r.id', 'p.currentRevisionId')
      .select([
        'p.id',
        'p.pageId',
        'p.sourceAssetId',
        'p.candidateId',
        'p.title',
        'p.version',
        'r.id as currentRevisionId',
        'r.revisionNumber',
        'r.startMs',
        'r.endMs',
        'r.aspect',
        'r.cropMode',
        sql<boolean>`r.captions IS NOT NULL`.as('hasCaptions'),
        'p.createdAt',
        'p.updatedAt',
      ])
      .where('p.archivedAt', 'is', null);
    if (pageIds !== null) query = query.where('p.pageId', 'in', pageIds);
    if (filter.pageId) query = query.where('p.pageId', '=', filter.pageId);
    if (filter.sourceAssetId) query = query.where('p.sourceAssetId', '=', filter.sourceAssetId);
    const rows = await query
      .orderBy('p.createdAt', 'desc')
      .orderBy('p.id', 'desc')
      .limit(LIST_LIMIT)
      .execute();
    return {
      clips: rows.map((row) => ({
        ...row,
        aspect: row.aspect as ClipAspect,
        cropMode: row.cropMode as ClipCropMode,
      })),
    };
  });
}

const createPostFromClipSchema = z.strictObject({
  /** Defaults to every enabled destination of the clip's page. */
  destinationIds: z.array(z.uuid()).min(1).max(10).optional(),
  caption: z.string().max(5000).optional(),
  title: z.string().trim().max(200).nullable().optional(),
});

export interface CreatePostFromClipResponse {
  postId: string;
  revisionId: string;
  clipId: string;
  /** The rendered asset attached to the draft. */
  assetId: string;
}

/**
 * Hand a rendered clip over to a draft post. This is `createPost` with the clip's page and its
 * rendered asset, so the draft then goes through the same submit, approval and schedule flow
 * as any upload; nothing here publishes. The clip's newest render must have finished: a clip
 * that was edited after its last render has to be rendered again first.
 */
export async function createPostFromClip(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  clipId: string,
  rawInput: unknown,
  meta: RequestMeta & { idempotencyKey?: string | null },
): Promise<{ status: number; body: CreatePostFromClipResponse; replayed: boolean }> {
  const input = createPostFromClipSchema.parse(rawInput ?? {});
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const project = await loadProject(tx, clipId, false);
    if (!project) throw new AppError('not_found', 'Clip not found');
    authorize(member, 'content.create', project.pageId);
    const render = await requireFinishedRender(tx, clipId);
    if (render.revisionId !== project.currentRevisionId)
      throw new AppError(
        'media_not_ready',
        'This clip was edited after its last render. Render it again first.',
      );

    let destinationIds = input.destinationIds;
    if (!destinationIds) {
      const rows = await tx
        .selectFrom('pageDestinations')
        .select('id')
        .where('pageId', '=', project.pageId)
        .where('enabled', '=', true)
        .where('archivedAt', 'is', null)
        .orderBy('id', 'asc')
        .limit(10)
        .execute();
      destinationIds = rows.map((row) => row.id);
      if (destinationIds.length === 0)
        throw new AppError('validation_failed', 'This page has no destinations to post to yet.', {
          fieldErrors: { destinationIds: ['Connect a destination to this page first'] },
        });
    }
    const created = await createPostIn(
      ctx,
      tx,
      member,
      workspaceId,
      createPostSchema.parse({
        pageId: project.pageId,
        title: input.title === undefined ? project.title : input.title,
        caption: input.caption ?? '',
        mediaAssetIds: [render.outputAssetId],
        destinationIds,
      }),
      meta,
    );
    if (!created.replayed) {
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: memberActor(member),
        action: 'clip.handed_off',
        entityType: 'clip_project',
        entityId: clipId,
        pageId: project.pageId,
        postId: created.body.postId,
        data: {
          postId: created.body.postId,
          renderJobId: render.id,
          revisionId: render.revisionId,
          assetId: render.outputAssetId,
        },
        requestId: meta.requestId,
      });
    }
    return {
      status: created.status,
      body: { ...created.body, clipId, assetId: render.outputAssetId },
      replayed: created.replayed,
    };
  });
}
