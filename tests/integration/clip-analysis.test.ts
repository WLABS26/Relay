import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { RANKER_VERSION } from '@relay/domain';
import { ANALYZER_VERSION, extractFeatures } from '@relay/media';
import { HIGHLIGHT_FIXTURE } from '@relay/media/fixtures';
import {
  acceptInvitation,
  getAnalysis,
  getAsset,
  getJobRun,
  inviteMember,
  listCandidates,
  revokeRightsGrant,
  setCandidateFeedback,
  startAnalysis,
  type AuthenticatedUser,
} from '@relay/services';
import { analysisFrameHeight, processAssetAnalysis } from '@relay/services/analysis';
import { toolConfig } from '@relay/services/media-pipeline';
import {
  createTenant,
  createUser,
  expectAppError,
  fixturePath,
  makeContexts,
  meta,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

const ATTEMPT = { number: 1, max: 3 };

describe('asset.analyze: highlight candidates (M2)', () => {
  let c: Contexts;
  let t: Tenant;
  let scratch: string;

  const run = (analysisId: string, attempt = ATTEMPT) =>
    processAssetAnalysis(c.worker, { workspaceId: t.workspaceId, analysisId }, attempt);

  const upload = async (name: string) =>
    (await uploadFixture(c, t, t.owner, name, 'video/mp4')).assetId;

  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(c.worker.db, { workspaceId: t.workspaceId }, fn);
  const candidateRows = (analysisId: string) =>
    inTenant((tx) =>
      tx.selectFrom('clipCandidates').selectAll().where('analysisId', '=', analysisId).execute(),
    );
  const usageRows = (analysisId: string) =>
    inTenant((tx) =>
      tx.selectFrom('usageEvents').selectAll().where('entityId', '=', analysisId).execute(),
    );
  const auditRows = (analysisId: string) =>
    inTenant((tx) =>
      tx.selectFrom('auditEvents').selectAll().where('entityId', '=', analysisId).execute(),
    );

  async function join(role: 'editor' | 'viewer'): Promise<AuthenticatedUser> {
    const user = await createUser(c.app, { name: `${role} user` });
    const invite = await inviteMember(
      c.app,
      t.owner,
      t.workspaceId,
      { email: user.email, role, allPages: true, pageIds: [] },
      meta,
    );
    await acceptInvitation(c.app, user, { token: invite.token }, meta);
    return user;
  }

  beforeAll(async () => {
    c = makeContexts();
    t = await createTenant(c.app);
    scratch = await mkdtemp(path.join(tmpdir(), 'relay-analysis-test-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await c.close();
  });

  describe('feature extraction through the sandbox', () => {
    it('finds the authored silences, scene cuts and burst in highlight.mp4', async () => {
      const dir = await mkdtemp(path.join(scratch, 'hl-'));
      const features = await extractFeatures(toolConfig(c.worker), {
        inputPath: fixturePath('highlight.mp4'),
        demuxer: 'mov',
        scratchDir: dir,
        hasAudio: true,
        durationMs: HIGHLIGHT_FIXTURE.durationMs,
      });
      for (const gap of HIGHLIGHT_FIXTURE.silences) {
        const found = features.silences.find(
          (s) => Math.abs(s.startMs - gap.startMs) <= 200 && Math.abs(s.endMs - gap.endMs) <= 200,
        );
        expect(found, `silence ${gap.startMs}-${gap.endMs}`).toBeDefined();
      }
      for (const cut of HIGHLIGHT_FIXTURE.sceneChangesMs) {
        expect(
          features.sceneChangesMs.some((ms) => Math.abs(ms - cut) <= 400),
          `scene cut at ${cut}`,
        ).toBe(true);
      }
      expect(features.sceneChangesMs).toHaveLength(HIGHLIGHT_FIXTURE.sceneChangesMs.length);

      const rms = features.rmsDb!;
      expect(rms.length).toBeGreaterThan(890);
      const { burst, silences } = HIGHLIGHT_FIXTURE;
      // Leave a 200 ms margin at each authored edge so codec ringing is not measured.
      const inBurst = (ms: number) => ms >= burst.startMs + 200 && ms < burst.endMs - 200;
      const nearEdge = (ms: number) =>
        [burst, ...silences].some(
          (r) => ms >= r.startMs - 200 && ms < r.endMs + 200 && !inBurst(ms),
        );
      const loud = rms.filter((_, i) => inBurst(i * 100));
      const rest = rms.filter((_, i) => !inBurst(i * 100) && !nearEdge(i * 100));
      expect(loud.length).toBeGreaterThan(50);
      expect(Math.min(...loud)).toBeGreaterThanOrEqual(Math.max(...rest) + 12);
    });

    it('succeeds without an audio stream and reports no envelope', async () => {
      const dir = await mkdtemp(path.join(scratch, 'na-'));
      const features = await extractFeatures(toolConfig(c.worker), {
        inputPath: fixturePath('square-720-noaudio-4s.mp4'),
        demuxer: 'mov',
        scratchDir: dir,
        hasAudio: false,
        durationMs: 4000,
      });
      expect(features.rmsDb).toBeNull();
      expect(features.silences).toEqual([]);
    });
  });

  it('refuses aspect ratios whose 320 px analysis frame would have no height', () => {
    expect(analysisFrameHeight(1920, 1080)).toBe(180);
    expect(analysisFrameHeight(720, 1280)).toBe(568);
    expect(analysisFrameHeight(321, 2)).toBeNull(); // 1.99 px: FFmpeg would be asked for 320x0
    expect(analysisFrameHeight(4096, 2)).toBeNull();
    expect(analysisFrameHeight(320, 2)).toBe(2);
    expect(analysisFrameHeight(2, 4096)).toBeNull(); // 320 x 655360 frames
    expect(analysisFrameHeight(null, 1080)).toBeNull();
    expect(analysisFrameHeight(0, 0)).toBeNull();
  });

  describe('synthetic peak, end to end', () => {
    let assetId: string;
    let analysisId: string;
    let jobId: string;

    beforeAll(async () => {
      assetId = await upload('highlight.mp4');
    });

    it('queues an analysis, then ranks the burst first with a persisted reason', async () => {
      const started = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
      expect(started.status).toBe(202);
      expect(started.body.analysis).toMatchObject({
        status: 'queued',
        assetId,
        analyzerVersion: ANALYZER_VERSION,
        rankerVersion: RANKER_VERSION,
        inputVariant: 'proxy',
      });
      analysisId = started.body.analysis.id;
      jobId = started.body.jobId!;
      const queued = await getJobRun(c.app, t.owner, t.workspaceId, jobId);
      expect(queued.entity).toMatchObject({ type: 'media_analysis', status: 'queued', assetId });

      expect(await run(analysisId)).toBe('succeeded');

      const { analysis, candidates } = await getAnalysis(c.app, t.owner, t.workspaceId, analysisId);
      expect(analysis).toMatchObject({
        status: 'succeeded',
        durationMs: HIGHLIGHT_FIXTURE.durationMs,
        hasAudio: true,
        coverage: 1,
        errorCode: null,
      });
      expect(analysis.summary).toMatchObject({ noSignal: false, hasAudio: true });
      expect(analysis.envelope!.points.length).toBeGreaterThan(100);
      expect(analysis.envelope!.points.length).toBeLessThanOrEqual(2000);
      expect(analysis.finishedAt).toBeInstanceOf(Date);

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.map((x) => x.rank)).toEqual(candidates.map((_, i) => i + 1));
      const top = candidates[0]!;
      const { burst } = HIGHLIGHT_FIXTURE;
      expect(top.startMs).toBeLessThan(burst.endMs);
      expect(top.endMs).toBeGreaterThan(burst.startMs);
      expect(top.startMs).toBeLessThanOrEqual(burst.startMs);
      expect(top.endMs - top.startMs).toBeGreaterThanOrEqual(15_000);
      expect(top.endMs - top.startMs).toBeLessThanOrEqual(60_000);
      expect(top.endMs).toBeLessThanOrEqual(HIGHLIGHT_FIXTURE.durationMs);
      expect(top.rankerVersion).toBe(RANKER_VERSION);
      expect(top.reason.length).toBeGreaterThan(10);
      expect(top.confidence).toBeGreaterThan(0);
      expect(top.score).toBeLessThanOrEqual(1);
      expect(top.feedback).toBeNull();

      const done = await getJobRun(c.app, t.owner, t.workspaceId, jobId);
      expect(done.job).toMatchObject({ status: 'succeeded', progress: 100, kind: 'asset.analyze' });
      expect(done.entity).toMatchObject({ status: 'succeeded' });

      const usage = await usageRows(analysisId);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ kind: 'media_seconds_processed' });
      expect(Number(usage[0]!.quantity)).toBe(90);
      const audit = await auditRows(analysisId);
      expect(audit.map((a) => a.action).sort()).toEqual([
        'analysis.completed',
        'analysis.requested',
      ]);
      const completed = audit.find((a) => a.action === 'analysis.completed')!;
      expect(completed.actorType).toBe('service');
      expect(completed.data).toMatchObject({
        candidateCount: candidates.length,
        rankerVersion: RANKER_VERSION,
        analyzerVersion: ANALYZER_VERSION,
      });
    });

    it('running the handler again inserts no duplicate candidates or usage', async () => {
      const before = await candidateRows(analysisId);
      expect(await run(analysisId)).toBe('skipped');
      expect(await run(analysisId, { number: 3, max: 3 })).toBe('skipped');
      const after = await candidateRows(analysisId);
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
      expect(await usageRows(analysisId)).toHaveLength(1);
    });

    it('a second request returns the existing analysis instead of starting another', async () => {
      const again = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
      expect(again.status).toBe(200);
      expect(again.body.analysis.id).toBe(analysisId);
      expect(again.body.analysis.status).toBe('succeeded');
      expect(again.body.jobId).toBe(jobId);
      const all = await withTenant(c.worker.db, { workspaceId: t.workspaceId }, (tx) =>
        tx.selectFrom('mediaAnalyses').select('id').where('assetId', '=', assetId).execute(),
      );
      expect(all).toHaveLength(1);
    });

    it('lists candidates in rank order and records reviewer feedback', async () => {
      const listed = await listCandidates(c.app, t.owner, t.workspaceId, assetId);
      expect(listed.analysis!.id).toBe(analysisId);
      expect(listed.jobId).toBe(jobId);
      const first = listed.candidates[0]!;
      const editor = await join('editor');
      const saved = await setCandidateFeedback(
        c.app,
        editor,
        t.workspaceId,
        first.id,
        { feedback: 'wrong_fit' },
        meta,
      );
      expect(saved.candidate).toMatchObject({ id: first.id, feedback: 'wrong_fit' });
      expect(saved.candidate.feedbackAt).toBeInstanceOf(Date);
      await expect(
        setCandidateFeedback(c.app, editor, t.workspaceId, first.id, { feedback: 'nope' }, meta),
      ).rejects.toThrow();
    });

    it('refuses a viewer, and hides the asset and its analysis from another tenant', async () => {
      const viewer = await join('viewer');
      await expectAppError(
        startAnalysis(c.app, viewer, t.workspaceId, { assetId }, meta),
        'forbidden',
      );
      const first = (await listCandidates(c.app, viewer, t.workspaceId, assetId)).candidates[0]!;
      await expectAppError(
        setCandidateFeedback(
          c.app,
          viewer,
          t.workspaceId,
          first.id,
          { feedback: 'accepted' },
          meta,
        ),
        'forbidden',
      );

      const other = await createTenant(c.app);
      await expectAppError(
        startAnalysis(c.app, other.owner, other.workspaceId, { assetId }, meta),
        'not_found',
      );
      await expectAppError(
        startAnalysis(c.app, other.owner, t.workspaceId, { assetId }, meta),
        'not_found',
      );
      await expectAppError(
        listCandidates(c.app, other.owner, other.workspaceId, assetId),
        'not_found',
      );
      await expectAppError(
        getAnalysis(c.app, other.owner, other.workspaceId, analysisId),
        'not_found',
      );
      await expectAppError(getJobRun(c.app, other.owner, other.workspaceId, jobId), 'not_found');
      // A payload naming another tenant's analysis finds nothing under that tenant's RLS.
      expect(
        await processAssetAnalysis(
          c.worker,
          { workspaceId: other.workspaceId, analysisId },
          ATTEMPT,
        ),
      ).toBe('skipped');
    });
  });

  it('analyses a video without audio on scene changes alone, with reduced coverage', async () => {
    const assetId = await upload('square-720-noaudio-4s.mp4');
    const started = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
    expect(await run(started.body.analysis.id)).toBe('succeeded');
    const { analysis } = await listCandidates(c.app, t.owner, t.workspaceId, assetId);
    expect(analysis).toMatchObject({ status: 'succeeded', hasAudio: false, envelope: null });
    expect(analysis!.summary).toMatchObject({ hasAudio: false });
    expect(analysis!.coverage).toBeLessThan(1);
  });

  it('fails with rights_missing, without retrying, when rights are revoked before the run', async () => {
    const assetId = await upload('highlight.mp4');
    const started = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
    const analysisId = started.body.analysis.id;
    const { grants } = await getAsset(c.app, t.owner, t.workspaceId, assetId);
    const revoked = await revokeRightsGrant(
      c.app,
      t.owner,
      t.workspaceId,
      { grantId: grants[0]!.id, reason: 'Consent withdrawn' },
      meta,
    );
    expect(revoked).toMatchObject({ assetId, alreadyRevoked: false });
    expect(
      await revokeRightsGrant(
        c.app,
        t.owner,
        t.workspaceId,
        { grantId: grants[0]!.id, reason: 'Again' },
        meta,
      ),
    ).toMatchObject({ alreadyRevoked: true });

    // First attempt of three: a rights failure is permanent, so it does not throw for a retry.
    expect(await run(analysisId)).toBe('failed');
    const { analysis, candidates } = await getAnalysis(c.app, t.owner, t.workspaceId, analysisId);
    expect(analysis).toMatchObject({ status: 'failed', errorCode: 'rights_missing' });
    expect(candidates).toEqual([]);
    expect(await usageRows(analysisId)).toEqual([]);
    const job = await getJobRun(c.app, t.owner, t.workspaceId, started.body.jobId!);
    expect(job.job).toMatchObject({ status: 'failed', errorCode: 'rights_missing' });
    expect(await run(analysisId)).toBe('skipped');

    // And a new request is refused while the rights stay revoked.
    await expectAppError(
      startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta),
      'rights_missing',
    );
  });

  it('retries a transient failure, then records processing_failed on the last attempt', async () => {
    const assetId = await upload('square-720-noaudio-4s.mp4');
    const started = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
    const analysisId = started.body.analysis.id;
    const broken = {
      ...c.worker,
      storage: Object.assign(Object.create(c.worker.storage as object), {
        downloadToFile: async () => {
          throw new Error('storage unavailable');
        },
      }),
    } as typeof c.worker;
    const payload = { workspaceId: t.workspaceId, analysisId };
    await expect(processAssetAnalysis(broken, payload, { number: 1, max: 3 })).rejects.toThrow(
      'storage unavailable',
    );
    expect((await getAnalysis(c.app, t.owner, t.workspaceId, analysisId)).analysis.status).toBe(
      'running',
    );
    expect(await processAssetAnalysis(broken, payload, { number: 3, max: 3 })).toBe('failed');
    expect((await getAnalysis(c.app, t.owner, t.workspaceId, analysisId)).analysis).toMatchObject({
      status: 'failed',
      errorCode: 'processing_failed',
    });

    // A failed analysis does not block a new one, and that one succeeds.
    const retry = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
    expect(retry.status).toBe(202);
    expect(retry.body.analysis.id).not.toBe(analysisId);
    expect(await run(retry.body.analysis.id)).toBe('succeeded');
    expect((await listCandidates(c.app, t.owner, t.workspaceId, assetId)).analysis!.id).toBe(
      retry.body.analysis.id,
    );
  });

  it('a redelivery after a crash mid-run completes once, and removes its scratch files', async () => {
    const assetId = await upload('square-720-noaudio-4s.mp4');
    const started = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
    const analysisId = started.body.analysis.id;
    const scratchDir = await mkdtemp(path.join(scratch, 'worker-'));
    const config = { ...c.worker.config, media: { ...c.worker.config.media, scratchDir } };
    const payload = { workspaceId: t.workspaceId, analysisId };
    const failing = {
      ...c.worker,
      config,
      storage: Object.assign(Object.create(c.worker.storage as object), {
        downloadToFile: async () => {
          throw new Error('worker lost');
        },
      }),
    } as typeof c.worker;
    await expect(processAssetAnalysis(failing, payload, { number: 1, max: 3 })).rejects.toThrow(
      'worker lost',
    );
    expect(await readdir(scratchDir)).toEqual([]);
    // The second delivery finds the analysis `running` and must finish it, not skip it.
    const worker = { ...c.worker, config } as typeof c.worker;
    expect(await processAssetAnalysis(worker, payload, { number: 2, max: 3 })).toBe('succeeded');
    expect(await readdir(scratchDir)).toEqual([]);
    const rows = await candidateRows(analysisId);
    expect(new Set(rows.map((r) => r.rank)).size).toBe(rows.length);
    expect(await usageRows(analysisId)).toHaveLength(1);
    expect((await getAnalysis(c.app, t.owner, t.workspaceId, analysisId)).analysis.status).toBe(
      'succeeded',
    );

    // A scratch root that cannot be used on the last attempt still fails the analysis.
    const second = await upload('square-720-noaudio-4s.mp4');
    const next = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId: second }, meta);
    const noScratch = {
      ...c.worker,
      config: {
        ...config,
        media: { ...config.media, scratchDir: path.join(scratchDir, 'missing') },
      },
    } as typeof c.worker;
    expect(
      await processAssetAnalysis(
        noScratch,
        { workspaceId: t.workspaceId, analysisId: next.body.analysis.id },
        { number: 3, max: 3 },
      ),
    ).toBe('failed');
  });

  it('leaves no candidates when rights are revoked while the video is being decoded', async () => {
    const assetId = await upload('highlight.mp4');
    const started = await startAnalysis(c.app, t.owner, t.workspaceId, { assetId }, meta);
    const analysisId = started.body.analysis.id;
    const { grants } = await getAsset(c.app, t.owner, t.workspaceId, assetId);
    const real = c.worker.storage;
    const revoking = {
      ...c.worker,
      storage: Object.assign(Object.create(real as object), {
        downloadToFile: async (...args: Parameters<typeof real.downloadToFile>) => {
          const result = await real.downloadToFile(...args);
          await revokeRightsGrant(
            c.app,
            t.owner,
            t.workspaceId,
            { grantId: grants[0]!.id, reason: 'Withdrawn mid-run' },
            meta,
          );
          return result;
        },
      }),
    } as typeof c.worker;
    expect(
      await processAssetAnalysis(revoking, { workspaceId: t.workspaceId, analysisId }, ATTEMPT),
    ).toBe('failed');
    const { analysis, candidates } = await getAnalysis(c.app, t.owner, t.workspaceId, analysisId);
    expect(analysis).toMatchObject({ status: 'failed', errorCode: 'rights_missing' });
    expect(candidates).toEqual([]);
    expect(await usageRows(analysisId)).toEqual([]);
  });

  it('refuses an asset that is still validating, and an image', async () => {
    const pending = await uploadFixture(c, t, t.owner, 'landscape-1280x720-6s.mp4', 'video/mp4', {
      process: false,
    });
    await expectAppError(
      startAnalysis(c.app, t.owner, t.workspaceId, { assetId: pending.assetId }, meta),
      'media_not_ready',
    );
    const image = await uploadFixture(c, t, t.owner, 'square-1080.png', 'image/png');
    await expectAppError(
      startAnalysis(c.app, t.owner, t.workspaceId, { assetId: image.assetId }, meta),
      'validation_failed',
    );
    await expect(
      startAnalysis(c.app, t.owner, t.workspaceId, { assetId: 'not-a-uuid' }, meta),
    ).rejects.toThrow();
  });
});
