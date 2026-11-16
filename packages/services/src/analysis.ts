import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql, withTenant, type Tx } from '@relay/db';
import {
  AppError,
  allowedTypeFor,
  candidateFeedbackSchema,
  downsampleEnvelope,
  RANKER_VERSION,
  rankHighlights,
  startAnalysisSchema,
  type Envelope,
  type RankSummary,
} from '@relay/domain';
import { ANALYZER_VERSION, extractFeatures, ObjectTooLargeError } from '@relay/media';
import { authorize, inWorkspace, memberActor, type AuthenticatedUser } from './access';
import { appendAudit, SERVICE_ACTORS } from './audit';
import type { RequestMeta, ServiceContext } from './context';
import { createJobRun, updateJobRun } from './jobs';
import { safeError } from './logger';
import { Rejection, toolConfig } from './media-pipeline';
import { evaluateRights, RIGHTS_PROBLEM_LABELS } from './rights';
import { enqueue, type TaskPayload } from './tasks';

/**
 * asset.analyze: find candidate highlights in an uploaded recording.
 *
 * The app role records the request (`startAnalysis`); the media worker decodes the validated
 * 960 px proxy once through the FFmpeg sandbox, extracts loudness, silences and scene cuts,
 * and runs the deterministic ranker (`processAssetAnalysis`). Candidates are suggestions with
 * the numbers that produced them; nothing here alters the source or creates a clip.
 */

/** The proxy written by `asset.probe`; analysis reads it instead of the original. */
const PROXY_PROFILE = 'h264-960';
const PROXY_DEMUXER = 'mov';
const ENVELOPE_MAX_POINTS = 2000;

/** The extraction graph scales every frame to this width and derives the height from it. */
const ANALYSIS_FRAME_WIDTH = 320;
const ANALYSIS_FRAME_MIN_HEIGHT = 2;
/** 320 x 4096 is about 1:13; anything taller is not a recording worth decoding at this width. */
const ANALYSIS_FRAME_MAX_HEIGHT = 4096;

export type AnalysisFailureCode =
  | 'rights_missing'
  | 'media_not_ready'
  | 'source_changed'
  | 'unsupported_aspect'
  | 'input_unavailable'
  | 'processing_failed';

/**
 * Height of the frames the extraction graph analyses for a source of the given display size,
 * or null when the source cannot be analysed. The graph scales to 320 px wide with a derived
 * even height, which is 0 for an extremely wide source (FFmpeg then fails) and enormous for an
 * extremely tall one, so both are refused before FFmpeg runs.
 */
export function analysisFrameHeight(width: number | null, height: number | null): number | null {
  if (!width || !height || width < 1 || height < 1) return null;
  const scaled = Math.round((ANALYSIS_FRAME_WIDTH * height) / width / 2) * 2;
  // Compare the exact ratio as well, so rounding up to 2 never hides a sub-pixel height.
  if ((ANALYSIS_FRAME_WIDTH * height) / width < ANALYSIS_FRAME_MIN_HEIGHT) return null;
  if (scaled < ANALYSIS_FRAME_MIN_HEIGHT || scaled > ANALYSIS_FRAME_MAX_HEIGHT) return null;
  return scaled;
}

function analysisMaxSourceMs(ctx: ServiceContext): number {
  return ctx.config.media.analysisMaxSourceSeconds * 1000;
}

const ASPECT_MESSAGE =
  'This video is too wide or too tall to analyse. You can still create a clip from a manual range.';

export interface AnalysisView {
  id: string;
  assetId: string;
  assetVersion: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  analyzerVersion: string;
  rankerVersion: string;
  inputVariant: 'proxy' | 'original';
  durationMs: number | null;
  hasAudio: boolean | null;
  coverage: number | null;
  envelope: Envelope | null;
  summary: RankSummary | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface CandidateView {
  id: string;
  analysisId: string;
  assetId: string;
  rank: number;
  startMs: number;
  endMs: number;
  score: number;
  confidence: number;
  reason: string;
  evidence: unknown;
  rankerVersion: string;
  feedback: string | null;
  feedbackAt: Date | null;
}

const ANALYSIS_COLUMNS = [
  'id',
  'assetId',
  'assetVersion',
  'status',
  'analyzerVersion',
  'rankerVersion',
  'inputVariant',
  'durationMs',
  'hasAudio',
  'coverage',
  'envelope',
  'summary',
  'errorCode',
  'errorDetail',
  'createdAt',
  'startedAt',
  'finishedAt',
] as const;

const CANDIDATE_COLUMNS = [
  'id',
  'analysisId',
  'assetId',
  'rank',
  'startMs',
  'endMs',
  'score',
  'confidence',
  'reason',
  'evidence',
  'rankerVersion',
  'feedback',
  'feedbackAt',
] as const;

async function loadAnalysisRow(tx: Tx, analysisId: string) {
  return tx
    .selectFrom('mediaAnalyses')
    .select(ANALYSIS_COLUMNS)
    .where('id', '=', analysisId)
    .executeTakeFirst();
}

type AnalysisRow = NonNullable<Awaited<ReturnType<typeof loadAnalysisRow>>>;

function toAnalysisView(row: AnalysisRow): AnalysisView {
  return {
    ...row,
    status: row.status as AnalysisView['status'],
    inputVariant: row.inputVariant as AnalysisView['inputVariant'],
    coverage: row.coverage === null ? null : Number(row.coverage),
    envelope: row.envelope as Envelope | null,
    summary: row.summary as RankSummary | null,
  };
}

async function loadCandidates(tx: Tx, analysisId: string): Promise<CandidateView[]> {
  const rows = await tx
    .selectFrom('clipCandidates')
    .select(CANDIDATE_COLUMNS)
    .where('analysisId', '=', analysisId)
    .orderBy('rank', 'asc')
    .execute();
  return rows.map((r) => ({ ...r, score: Number(r.score), confidence: Number(r.confidence) }));
}

/** The asset as the member may see it, or `not_found` (also for another tenant's ID). */
async function loadAssetFor(tx: Tx, assetId: string) {
  const asset = await tx
    .selectFrom('mediaAssets')
    .select([
      'id',
      'pageId',
      'kind',
      'status',
      'origin',
      'version',
      'width',
      'height',
      'durationMs',
      'hasAudio',
    ])
    .where('id', '=', assetId)
    .executeTakeFirst();
  if (!asset || asset.status === 'deleted') throw new AppError('not_found', 'Media not found');
  return asset;
}

export interface StartAnalysisResponse {
  analysis: AnalysisView;
  /** The job that tracks this analysis (GET /jobs/:jobId), when one was recorded. */
  jobId: string | null;
}

/**
 * Ask for an analysis of a ready, uploaded video. Returns the existing analysis (200) when one
 * is queued, running or finished for the current analyzer and ranker versions; otherwise
 * records a new one and enqueues `asset.analyze` (202).
 */
export async function startAnalysis(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawInput: unknown,
  meta: RequestMeta,
): Promise<{ status: 200 | 202; body: StartAnalysisResponse }> {
  const input = startAnalysisSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const asset = await loadAssetFor(tx, input.assetId);
    authorize(member, 'content.create', asset.pageId);
    if (asset.kind !== 'video')
      throw new AppError('validation_failed', 'Only videos can be analysed for clips.', {
        fieldErrors: { assetId: ['Choose a video'] },
      });
    if (asset.origin === 'render')
      throw new AppError('validation_failed', 'A rendered clip cannot be analysed again.', {
        fieldErrors: { assetId: ['Choose an uploaded video, not a rendered clip'] },
      });
    if (asset.status !== 'ready' || !asset.durationMs)
      throw new AppError('media_not_ready', 'This media is still being validated or was rejected.');
    const maxMs = analysisMaxSourceMs(ctx);
    if (asset.durationMs > maxMs)
      throw new AppError(
        'validation_failed',
        `Videos longer than ${Math.floor(maxMs / 60_000)} minutes cannot be analysed.`,
        { fieldErrors: { assetId: ['This video is too long to analyse'] } },
      );
    if (analysisFrameHeight(asset.width, asset.height) === null)
      throw new AppError('validation_failed', ASPECT_MESSAGE, {
        fieldErrors: { assetId: ['Unsupported aspect ratio'] },
      });
    const rights = await evaluateRights(tx, {
      assetIds: [asset.id],
      operation: 'edit',
      at: ctx.clock.now(),
    });
    if (!rights.ok) {
      const reason = rights.problems[0]?.reason ?? 'no_grant';
      throw new AppError(
        'rights_missing',
        reason === 'operation_denied'
          ? 'The recorded rights do not allow editing this media.'
          : RIGHTS_PROBLEM_LABELS[reason],
        { details: { problems: rights.problems } },
      );
    }

    // Two requests for the same asset must not both pass the "is there one already" check; the
    // partial unique index would reject the second insert and abort its transaction.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`analysis:${asset.id}`}, 0))`.execute(
      tx,
    );
    const existing = await tx
      .selectFrom('mediaAnalyses')
      .select(ANALYSIS_COLUMNS)
      .where('assetId', '=', asset.id)
      .where('analyzerVersion', '=', ANALYZER_VERSION)
      .where('rankerVersion', '=', RANKER_VERSION)
      .where('status', 'in', ['queued', 'running', 'succeeded'])
      .executeTakeFirst();
    if (existing) {
      const job = await tx
        .selectFrom('jobRuns')
        .select('id')
        .where('entityType', '=', 'media_analysis')
        .where('entityId', '=', existing.id)
        .orderBy('createdAt', 'desc')
        .executeTakeFirst();
      return { status: 200, body: { analysis: toAnalysisView(existing), jobId: job?.id ?? null } };
    }

    const analysisId = ctx.ids.next();
    const hasProxy = await tx
      .selectFrom('mediaVariants')
      .select('id')
      .where('assetId', '=', asset.id)
      .where('kind', '=', 'proxy')
      .where('profile', '=', PROXY_PROFILE)
      .executeTakeFirst();
    await tx
      .insertInto('mediaAnalyses')
      .values({
        id: analysisId,
        workspaceId,
        assetId: asset.id,
        assetVersion: asset.version,
        status: 'queued',
        analyzerVersion: ANALYZER_VERSION,
        rankerVersion: RANKER_VERSION,
        inputVariant: hasProxy ? 'proxy' : 'original',
        requestedBy: user.userId,
      })
      .execute();
    const jobId = await createJobRun(tx, ctx, {
      workspaceId,
      kind: 'asset.analyze',
      entityType: 'media_analysis',
      entityId: analysisId,
      correlationId: meta.requestId,
    });
    await enqueue(
      tx,
      'asset.analyze',
      { workspaceId, analysisId, correlationId: meta.requestId },
      { jobKey: `asset.analyze:${analysisId}`, jobKeyMode: 'unsafe_dedupe' },
    );
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'analysis.requested',
      entityType: 'media_analysis',
      entityId: analysisId,
      pageId: asset.pageId,
      data: {
        assetId: asset.id,
        analyzerVersion: ANALYZER_VERSION,
        rankerVersion: RANKER_VERSION,
      },
      requestId: meta.requestId,
    });
    const created = await loadAnalysisRow(tx, analysisId);
    return { status: 202, body: { analysis: toAnalysisView(created!), jobId } };
  });
}

export async function getAnalysis(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  analysisId: string,
): Promise<{ analysis: AnalysisView; candidates: CandidateView[] }> {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const row = await loadAnalysisRow(tx, analysisId);
    if (!row) throw new AppError('not_found', 'Analysis not found');
    const asset = await loadAssetFor(tx, row.assetId);
    authorize(member, 'media.view', asset.pageId);
    return { analysis: toAnalysisView(row), candidates: await loadCandidates(tx, row.id) };
  });
}

/**
 * The newest analysis of an asset and its candidates in rank order. `analysis` is null when
 * none was ever requested; candidates exist only once it has succeeded.
 */
export async function listCandidates(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  assetId: string,
): Promise<{ analysis: AnalysisView | null; jobId: string | null; candidates: CandidateView[] }> {
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const asset = await loadAssetFor(tx, assetId);
    authorize(member, 'media.view', asset.pageId);
    const row = await tx
      .selectFrom('mediaAnalyses')
      .select(ANALYSIS_COLUMNS)
      .where('assetId', '=', assetId)
      // Newest first, whatever its status, so a failed retry is shown rather than hidden behind
      // an older result. IDs are UUIDv7 and break ties between rows created in the same instant.
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!row) return { analysis: null, jobId: null, candidates: [] };
    const job = await tx
      .selectFrom('jobRuns')
      .select('id')
      .where('entityType', '=', 'media_analysis')
      .where('entityId', '=', row.id)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    return {
      analysis: toAnalysisView(row),
      jobId: job?.id ?? null,
      candidates: await loadCandidates(tx, row.id),
    };
  });
}

/** Record a reviewer's verdict on a suggestion (Relay first-party data, never sent anywhere). */
export async function setCandidateFeedback(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  candidateId: string,
  rawInput: unknown,
  meta: RequestMeta,
): Promise<{ candidate: CandidateView }> {
  const input = candidateFeedbackSchema.parse(rawInput);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    const candidate = await tx
      .selectFrom('clipCandidates')
      .select(['id', 'assetId', 'analysisId'])
      .where('id', '=', candidateId)
      .executeTakeFirst();
    if (!candidate) throw new AppError('not_found', 'Suggestion not found');
    const asset = await loadAssetFor(tx, candidate.assetId);
    authorize(member, 'content.edit', asset.pageId);
    await tx
      .updateTable('clipCandidates')
      .set({ feedback: input.feedback, feedbackBy: user.userId, feedbackAt: ctx.clock.now() })
      .where('id', '=', candidateId)
      .execute();
    await appendAudit(tx, ctx.ids, {
      workspaceId,
      actor: memberActor(member),
      action: 'candidate.feedback',
      entityType: 'clip_candidate',
      entityId: candidateId,
      pageId: asset.pageId,
      data: { assetId: asset.id, analysisId: candidate.analysisId, feedback: input.feedback },
      requestId: meta.requestId,
    });
    const updated = (await loadCandidates(tx, candidate.analysisId)).find(
      (c) => c.id === candidateId,
    );
    return { candidate: updated! };
  });
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(Math.min(Math.max(value, 0), 1) * factor) / factor;
};

/**
 * Worker handler for `asset.analyze`. The payload is a hint: the analysis, the asset and the
 * rights are reloaded here, and a duplicate or late delivery is a no-op.
 */
export async function processAssetAnalysis(
  ctx: ServiceContext,
  payload: TaskPayload<'asset.analyze'>,
  attempt: { number: number; max: number },
): Promise<'succeeded' | 'failed' | 'skipped'> {
  const { workspaceId, analysisId } = payload;

  /** Record a permanent failure; a no-op when the analysis already left queued/running. */
  const fail = async (
    rejection: Rejection<AnalysisFailureCode>,
    pageId: string | null,
  ): Promise<'failed' | 'skipped'> =>
    withTenant(ctx.db, { workspaceId }, async (tx) => {
      const now = ctx.clock.now();
      const updated = await tx
        .updateTable('mediaAnalyses')
        .set({
          status: 'failed',
          errorCode: rejection.code,
          errorDetail: rejection.detail.slice(0, 500),
          finishedAt: now,
        })
        .where('id', '=', analysisId)
        .where('status', 'in', ['queued', 'running'])
        .returning('id')
        .executeTakeFirst();
      if (!updated) return 'skipped';
      await updateJobRun(tx, {
        entityType: 'media_analysis',
        entityId: analysisId,
        kind: 'asset.analyze',
        status: 'failed',
        errorCode: rejection.code,
        errorMessage: rejection.detail,
      });
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.media,
        action: 'analysis.failed',
        entityType: 'media_analysis',
        entityId: analysisId,
        pageId,
        data: { code: rejection.code },
        correlationId: payload.correlationId ?? null,
      });
      return 'failed';
    });

  type Loaded =
    | { kind: 'skip' }
    | { kind: 'reject'; rejection: Rejection<AnalysisFailureCode>; pageId: string | null }
    | {
        kind: 'run';
        pageId: string;
        assetId: string;
        durationMs: number;
        hasAudio: boolean;
        input: {
          variant: 'proxy' | 'original';
          key: string;
          versionId: string | null;
          etag: string | null;
          maxBytes: number;
          demuxer: string;
        };
      };

  const loaded = await withTenant(ctx.db, { workspaceId }, async (tx): Promise<Loaded> => {
    const analysis = await tx
      .selectFrom('mediaAnalyses')
      .select(['id', 'assetId', 'assetVersion', 'status'])
      .where('id', '=', analysisId)
      .executeTakeFirst();
    // Stale, duplicate or already handled.
    if (!analysis || (analysis.status !== 'queued' && analysis.status !== 'running'))
      return { kind: 'skip' };
    const asset = await tx
      .selectFrom('mediaAssets')
      .selectAll()
      .where('id', '=', analysis.assetId)
      .executeTakeFirst();
    const reject = (code: AnalysisFailureCode, detail: string): Loaded => ({
      kind: 'reject',
      rejection: new Rejection(code, detail),
      pageId: asset?.pageId ?? null,
    });
    if (!asset || asset.status !== 'ready' || asset.kind !== 'video' || !asset.durationMs)
      return reject('media_not_ready', 'The source video is no longer available.');
    if (asset.version !== analysis.assetVersion)
      return reject('source_changed', 'The source video changed after the analysis was requested.');
    // Rights can be withdrawn between the request and the run; the worker never trusts the
    // decision made when the job was enqueued.
    const rights = await evaluateRights(tx, {
      assetIds: [asset.id],
      operation: 'edit',
      at: ctx.clock.now(),
    });
    if (!rights.ok)
      return reject(
        'rights_missing',
        'The rights recorded for this media no longer allow editing it.',
      );
    if (analysisFrameHeight(asset.width, asset.height) === null)
      return reject('unsupported_aspect', ASPECT_MESSAGE);

    const proxy = await tx
      .selectFrom('mediaVariants')
      .select(['objectKey', 'objectVersionId', 'sizeBytes'])
      .where('assetId', '=', asset.id)
      .where('kind', '=', 'proxy')
      .where('profile', '=', PROXY_PROFILE)
      .executeTakeFirst();
    let input: Extract<Loaded, { kind: 'run' }>['input'];
    if (proxy) {
      input = {
        variant: 'proxy',
        key: proxy.objectKey,
        versionId: proxy.objectVersionId,
        etag: null,
        maxBytes: proxy.sizeBytes,
        demuxer: PROXY_DEMUXER,
      };
    } else {
      // No proxy (an asset validated before proxies existed): read the validated original
      // with the demuxer its declared type forces, exactly as asset.probe did.
      const type = allowedTypeFor(asset.declaredMime);
      if (!type || type.kind !== 'video')
        return reject('input_unavailable', 'This video has no analysable rendition.');
      input = {
        variant: 'original',
        key: asset.objectKey,
        versionId: asset.objectVersionId,
        etag: asset.objectEtag,
        maxBytes: asset.sizeBytes,
        demuxer: type.demuxer,
      };
    }

    await tx
      .updateTable('mediaAnalyses')
      .set({ status: 'running', startedAt: sql`COALESCE(started_at, ${ctx.clock.now()})` })
      .where('id', '=', analysisId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
    await updateJobRun(tx, {
      entityType: 'media_analysis',
      entityId: analysisId,
      kind: 'asset.analyze',
      status: 'running',
      progress: 5,
    });
    return {
      kind: 'run',
      pageId: asset.pageId,
      assetId: asset.id,
      durationMs: asset.durationMs,
      hasAudio: asset.hasAudio === true,
      input,
    };
  });
  if (loaded.kind === 'skip') return 'skipped';
  if (loaded.kind === 'reject') return fail(loaded.rejection, loaded.pageId);

  const scratchRoot = ctx.config.media.scratchDir ?? tmpdir();
  // Created inside the try: a scratch volume that is full or missing on the last attempt must
  // still mark the analysis failed instead of leaving it `running` and blocking a new request.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(scratchRoot, 'relay-analyze-'));
    const inputPath = path.join(dir, 'input');
    try {
      await ctx.storage.downloadToFile({
        key: loaded.input.key,
        versionId: loaded.input.versionId,
        ifMatch: loaded.input.etag,
        path: inputPath,
        maxBytes: loaded.input.maxBytes,
      });
    } catch (error) {
      if (error instanceof ObjectTooLargeError)
        throw new Rejection<AnalysisFailureCode>(
          'input_unavailable',
          'The stored video is larger than recorded.',
        );
      throw error;
    }
    // FFmpeg writes its side files into a directory of its own, away from the input.
    const featureDir = await mkdtemp(path.join(dir, 'features-'));
    const features = await extractFeatures(toolConfig(ctx), {
      inputPath,
      demuxer: loaded.input.demuxer,
      scratchDir: featureDir,
      hasAudio: loaded.hasAudio,
      durationMs: loaded.durationMs,
    });
    const ranked = rankHighlights(features);
    const envelope = downsampleEnvelope(features.rmsDb, ENVELOPE_MAX_POINTS);

    return await withTenant(ctx.db, { workspaceId }, async (tx) => {
      const now = ctx.clock.now();
      // A revoke during a long decode must not leave suggestions behind.
      const rights = await evaluateRights(tx, {
        assetIds: [loaded.assetId],
        operation: 'edit',
        at: now,
      });
      if (!rights.ok)
        throw new Rejection<AnalysisFailureCode>(
          'rights_missing',
          'The rights recorded for this media no longer allow editing it.',
        );
      const updated = await tx
        .updateTable('mediaAnalyses')
        .set({
          status: 'succeeded',
          durationMs: loaded.durationMs,
          hasAudio: loaded.hasAudio,
          coverage: String(round(ranked.summary.coverage, 3)),
          envelope: envelope === null ? null : JSON.stringify(envelope),
          summary: JSON.stringify(ranked.summary),
          errorCode: null,
          errorDetail: null,
          finishedAt: now,
        })
        .where('id', '=', analysisId)
        .where('status', '=', 'running')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return 'skipped'; // another delivery finished (or failed) it first
      for (const candidate of ranked.candidates) {
        await tx
          .insertInto('clipCandidates')
          .values({
            id: ctx.ids.next(),
            workspaceId,
            analysisId,
            assetId: loaded.assetId,
            rank: candidate.rank,
            startMs: candidate.startMs,
            endMs: candidate.endMs,
            score: String(round(candidate.score, 4)),
            confidence: String(round(candidate.confidence, 3)),
            reason: candidate.reason.slice(0, 500),
            evidence: JSON.stringify(candidate.evidence),
            rankerVersion: ranked.rankerVersion,
          })
          .onConflict((oc) => oc.columns(['analysisId', 'rank']).doNothing())
          .execute();
      }
      await tx
        .insertInto('usageEvents')
        .values({
          id: ctx.ids.next(),
          workspaceId,
          kind: 'media_seconds_processed',
          quantity: String(loaded.durationMs / 1000),
          entityType: 'media_analysis',
          entityId: analysisId,
        })
        .execute();
      await updateJobRun(tx, {
        entityType: 'media_analysis',
        entityId: analysisId,
        kind: 'asset.analyze',
        status: 'succeeded',
        progress: 100,
      });
      await appendAudit(tx, ctx.ids, {
        workspaceId,
        actor: SERVICE_ACTORS.media,
        action: 'analysis.completed',
        entityType: 'media_analysis',
        entityId: analysisId,
        pageId: loaded.pageId,
        data: {
          assetId: loaded.assetId,
          analyzerVersion: ANALYZER_VERSION,
          rankerVersion: ranked.rankerVersion,
          inputVariant: loaded.input.variant,
          candidateCount: ranked.candidates.length,
          sceneChangeCount: features.sceneChangesMs.length,
          silenceCount: features.silences.length,
          hasAudio: loaded.hasAudio,
          noSignal: ranked.summary.noSignal,
        },
        correlationId: payload.correlationId ?? null,
      });
      return 'succeeded';
    });
  } catch (error) {
    const rejection =
      error instanceof Rejection
        ? (error as Rejection<AnalysisFailureCode>)
        : attempt.number >= attempt.max
          ? new Rejection<AnalysisFailureCode>(
              'processing_failed',
              'Relay could not analyse this video after several attempts.',
            )
          : null;
    if (!rejection) {
      ctx.logger.warn(
        { analysisId, err: safeError(error), attempt: attempt.number },
        'asset.analyze failed; will retry',
      );
      throw error; // let the queue retry with backoff
    }
    return await fail(rejection, loaded.pageId);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
