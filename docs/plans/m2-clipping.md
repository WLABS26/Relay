# M2 · Clipping tool: build plan

Produced by a planning pass over the codebase on 2026-11-16. A plan, not a record of work done:
progress is tracked in `docs/implementation-status.md`.

## Scope

Plan only; no files were changed. I read the spec (section 6, M2), the status doc, `0005_media.sql`, `rights.ts`, `tasks.ts`, `keys.ts`, `posts.ts`, `uploads.ts`, the worker Dockerfile and the env config; nothing was run except greps and a font listing.

**In scope (first usable clipping tool):** existing upload -> `asset.analyze` in the media pool -> ranked candidates with reasons -> non-destructive editor (range, 9:16 / 1:1 / original, fit / fill, burned-in captions) -> `clip.render` by decode and re-encode into a new `media_assets` row with `origin='render'` -> draft post through the unchanged `createPost` / approval / schedule flow.

**Out of scope here:** URL resolver, live signals, time alignment, manual crop and keyframed anchors, overlays, title cards, sidecar caption export, clips of clips. Meta and other real provider adapters and the page-speed fixes from the user's request are separate workflow steps; this plan only avoids making the speed problem worse.

**Design decisions the steps depend on**

- **Timeline:** all times are milliseconds on a 0-based media timeline (first video frame = 0), which is what the browser reports for the proxy. `startMs` is inclusive, `endMs` exclusive.
- **Output asset is pre-created by the app role.** `relay_worker` has no INSERT on `media_assets`, `created_by` is NOT NULL and the worker cannot read `users`. So `requestClipRender` inserts the output row as `status='validating'`, `origin='render'`, with `size_bytes` set to the reserved maximum. That also makes it count against `workspaceStorageUsage` with no change there. The worker then fills probe columns and moves it to `ready` or `rejected`, exactly as `processAssetProbe` does.
- **Rights are inherited by lineage, not copied.** A derived asset gets no grant rows of its own. `evaluateRights` resolves a derived asset to its source through `render_jobs` and evaluates the source's grants, so revoking the source blocks its clips at approve, schedule and dispatch without any extra call site.
- **Analysis reads the `proxy/h264-960` variant** (960 px, 30 fps, already validated); rendering always reads the pinned original.
- **Analysis results stay out of `media_variants`.** Candidates and a downsampled envelope are stored in new tables, so the `kind` CHECK and `assetVariantKey` union are not touched.
- **FFmpeg side files use relative names with `cwd` set to the scratch directory** (`rms.txt`, `scene.txt`, `captions.ass`, `fonts/`). No path is ever interpolated into a filter graph, so no escaping helper is needed.

## Steps

### 1. Schema: migration 0013_clipping.sql, grants, generated types

**Files:** `packages/db/migrations/0013_clipping.sql`, `packages/db/src/schema-version.ts`, `packages/db/src/generated/db.ts`, `tests/integration/tenancy.test.ts`

One new file; 0001-0012 are untouched. Follow the 0005/0006 conventions: app-supplied UUIDv7 `id`, `workspace_id NOT NULL`, `UNIQUE (workspace_id, id)`, composite tenant FKs, text CHECK enums, `pg_column_size` caps, `relay_touch_updated_at` where there is an `updated_at`, and `SELECT relay_apply_tenant_rls('<table>')` per table.

**Tables**

- `media_analyses`: `asset_id`, `asset_version`, `status` (`queued|running|succeeded|failed`), `analyzer_version`, `ranker_version`, `input_variant` (`proxy|original`), `duration_ms`, `has_audio`, `coverage numeric(4,3)`, `envelope jsonb` (at most 2000 points, cap 64 KiB), `summary jsonb` (cap 8 KiB), `error_code`, `error_detail`, `requested_by`, timestamps. Partial unique index on `(asset_id, analyzer_version, ranker_version) WHERE status IN ('queued','running','succeeded')`.
- `clip_candidates`: `analysis_id`, `asset_id`, `rank`, `start_ms >= 0`, `end_ms > start_ms`, `score numeric(5,4)`, `confidence numeric(4,3)`, `reason text` (<= 500), `evidence jsonb` (cap 4 KiB), `ranker_version`, `feedback` (`accepted|trim_adjusted|missing_context|wrong_fit|rights_issue`, nullable), `feedback_by`, `feedback_at`. `UNIQUE (analysis_id, rank)`.
- `clip_projects`: `page_id`, `source_asset_id`, `source_asset_version`, `candidate_id` (nullable), `title` (1-120), `current_revision_id`, `version integer` (optimistic), `created_by`, `archived_at`.
- `clip_revisions` (immutable via `relay_forbid_mutation`): `clip_id`, `revision_number`, `start_ms`, `end_ms`, `aspect` (`9:16|1:1|original`), `crop_mode` (`fit|fill`), `captions jsonb` (cap 128 KiB, nullable), `caption_style` (`default`), `edit_hash` (sha256 hex), `created_by`. `UNIQUE (clip_id, revision_number)`.
- `render_jobs`: `clip_id`, `revision_id`, `profile` (`mp4-h264-aac`), `render_key` (sha256 hex), `status` (`queued|running|succeeded|failed`), `source_asset_id`, `source_asset_version`, `source_rights_version`, `output_asset_id` (`UNIQUE`), `renderer_version`, `output_probe jsonb` (cap 16 KiB), `render_ms`, `error_code`, `error_detail`, `requested_by`, timestamps. Partial unique index on `(workspace_id, render_key) WHERE status IN ('queued','running','succeeded')`: this is the spec's "unique successful derivative per render key".

**Trigger:** new function `relay_bump_derived_rights_version()` and trigger `source_rights_grants_bump_derived AFTER INSERT OR UPDATE ON source_rights_grants`. It increments `media_assets.rights_version` for every `render_jobs.output_asset_id` whose `source_asset_id = NEW.asset_id`, so existing approvals on clips are invalidated when the source's rights change. Declare it the same way (invoker or definer) as the existing `relay_bump_rights_version` in 0005.

**Grants (explicit, column-level)**

- `media_analyses`: app SELECT, INSERT; worker SELECT, UPDATE (`status, duration_ms, has_audio, coverage, envelope, summary, error_code, error_detail, started_at, finished_at, updated_at`).
- `clip_candidates`: app SELECT, UPDATE (`feedback, feedback_by, feedback_at`); worker SELECT, INSERT.
- `clip_projects`: app SELECT, INSERT, UPDATE (`title, current_revision_id, version, archived_at, updated_at`); worker SELECT.
- `clip_revisions`: app SELECT, INSERT; worker SELECT.
- `render_jobs`: app SELECT, INSERT; worker SELECT, UPDATE (`status, renderer_version, output_probe, render_ms, error_code, error_detail, started_at, finished_at, updated_at`).
- `media_assets`: add `GRANT UPDATE (size_bytes) ON media_assets TO relay_worker`. The guard trigger already forbids a size change once the row is `ready`.
- `relay_apply_maintenance_scan('render_jobs')` and `('media_analyses')` for a later stuck-job sweep.

Then set `REQUIRED_SCHEMA_VERSION = '0013'` and run `pnpm db:types`.

**Tests:** `pnpm db:migrate`, `pnpm db:types:check`, and `packages/db/src/schema-version.test.ts` (newest file equals the constant, no gaps). Extend `tests/integration/tenancy.test.ts`: the five tables fail closed without tenant context; cross-tenant inserts and composite FKs are rejected; the worker cannot INSERT `clip_projects` or `clip_revisions`; the app cannot INSERT `clip_candidates`; UPDATE on `clip_revisions` raises; a second active `render_jobs` row with the same `render_key` violates the partial index.

### 2. Domain: clip range, geometry, render key, schemas, permissions

**Files:** `packages/domain/src/clip.ts`, `packages/domain/src/clip.test.ts`, `packages/domain/src/schemas.ts`, `packages/domain/src/roles.ts`, `packages/domain/src/errors.ts`, `packages/domain/src/server.ts`, `packages/domain/src/index.ts`

Pure code, no clock or randomness.

- `validateClipRange({startMs, endMs, sourceDurationMs, minMs, maxMs})`: integers, `0 <= startMs < endMs <= sourceDurationMs`, length within limits.
- `clipFrameCount(startMs, endMs, fps = 30)`: the single definition of how many frames a range yields. Used by the renderer and by tests.
- `clipGeometry({sourceWidth, sourceHeight, aspect, cropMode})` takes display dimensions from `NormalizedMedia` (after rotation) and returns `{outWidth, outHeight, scaleWidth, scaleHeight, cropX, cropY, padX, padY}`, all even integers.
  - Targets: 9:16 -> 1080x1920, 1:1 -> 1080x1080, original -> source rounded down to even.
  - No upscaling: if the source's short side cannot fill the target, scale the target down by the same aspect (for example 720x1280).
  - `fill` = scale to cover, centre crop. `fit` = scale to contain, pad black.
  - The web preview and `renderClip` both call this function (spec 6.5).
- `CLIP_PROFILE = 'mp4-h264-aac'`, `CLIP_FPS = 30`.
- `clipEditHash(revision)` and `renderKey({editHash, profile, sourceAssetId, sourceAssetVersion, sourceSha256, rendererVersion})` in `server.ts`, built on the existing `canonicalJson` and `sha256Hex`.
- zod `strictObject` schemas: `startAnalysisSchema`, `createClipSchema` (`sourceAssetId`, plus `candidateId` or `startMs`/`endMs`, optional `title`), `updateClipSchema` (`version`, `startMs`, `endMs`, `aspect`, `cropMode`, `captions`, `title`), `requestRenderSchema` (`revisionId` optional), `candidateFeedbackSchema`.
- Permissions: reuse `media.view`, `content.create`, `content.edit`, `content.export`. No new `Action` is needed; all are page-scoped through the source asset's `pageId`.
- Add error codes only if missing in `ERROR_STATUS`: `rights_missing`, `media_not_ready`, `version_conflict` and `quota_exceeded` already exist.

**Tests:** `packages/domain/src/clip.test.ts` (unit):

- range rejects `endMs <= startMs`, negative values and ranges past the duration;
- `clipFrameCount(1000, 3000) === 60`;
- geometry table: 1920x1080 fill 9:16 -> 1080x1920 with a centred crop; 1280x720 fill 9:16 -> 404x720 (even, no upscale); 721x1279 original -> 720x1278; 720x720 fit 9:16 -> pad top and bottom; a rotated source uses display dimensions;
- every output is even and positive;
- `renderKey` is stable under key reordering and changes when any input changes.

### 3. Domain: captions (SRT/VTT parse, validate, ASS output)

**Files:** `packages/domain/src/captions.ts`, `packages/domain/src/captions.test.ts`, `packages/domain/src/index.ts`

- `parseSrt(text)` and `parseVtt(text)` return `Cue[] = {startMs, endMs, text}`. Strip the BOM, accept CRLF, drop VTT `NOTE`/`STYLE`/`REGION` blocks and cue settings, and strip all markup tags. Input is capped at 200 KiB before parsing.
- `validateCues(cues, {clipStartMs, clipEndMs})` (spec 6.5): at most 500 cues; `startMs < endMs`; ascending order; no overlap; at most 2 lines of at most 42 characters; minimum cue length 300 ms; NFC-normalised; reject control, invisible and bidirectional code points. Write those code points as `\u{...}` escapes in source, or `pnpm lint` fails. Returns field-addressable errors (`captions.3.text`).
- Cues are stored on the source timeline, so trimming never shifts them. Import offers "times start at the clip start" (the default), which adds `startMs`.
- `cuesForRender(cues, startMs, endMs)`: shift by `-startMs`, clip to the range, drop empties.
- `toAss(cues, {width, height, style: 'default'})` builds the whole file from Relay's own tokens: one fixed `Style` (font family from a constant, size proportional to height, outline, bottom margin as a share of height) and `Dialogue` lines with `{`, `}` and `\` escaped and newlines as `\N`. User text never reaches FFmpeg in any other form; an uploaded SRT is always re-serialised (spec 6.3).

**Tests:** `packages/domain/src/captions.test.ts` (unit): SRT and VTT round trip; BOM and CRLF; hours-optional VTT timestamps; malformed timecode rejected with the cue index; overlap and out-of-order rejected; a 43-character line and a third line rejected; a bidi override rejected; `toAss` escapes `{\an8}` and backslashes so no override tag survives; `cuesForRender` clips a cue that straddles `endMs` and drops one outside the range.

### 4. Domain: deterministic highlight ranker

**Files:** `packages/domain/src/ranker.ts`, `packages/domain/src/ranker.test.ts`, `packages/domain/src/index.ts`

`RANKER_VERSION = 'relay-ranker@1'`.

`rankHighlights(features, options)` where `features = {durationMs, rmsDb: number[] | null (100 ms hop), silences: {startMs, endMs}[], sceneChangesMs: number[]}` and options default to `{windowMs: 5000, strideMs: 2500, minMs: 15000, maxMs: 60000, maxCandidates: 10, iou: 0.5}`.

1. **Windows:** 5 s windows at 2.5 s stride. Per window: `energy` (mean linear RMS), `onset` (largest positive jump of the 500 ms smoothed envelope), `scene` (scene changes per window).
2. **Scoring:** robust z per feature = `(x - median) / (1.4826 * MAD + floor)`, clamped to 0..4 and divided by 4. Weights: energy 0.45, onset 0.30, scene 0.25, renormalised over the signals that exist (no audio -> scene only). These are the v1 mapping of the spec's "source cues" and live in one exported constant.
3. **Coverage:** `available signals / 3` times sample completeness. `confidence = score * coverage`, so a low-coverage window never looks certain.
4. **Peaks:** local maxima above a minimum score, taken greedily by score.
5. **Range:** start snaps to the end of the nearest silence within 8 s before the peak window, otherwise pads 3 s back. End snaps to the next silence start after the peak, otherwise pads forward. Clamp to 15-60 s and to `[0, durationMs]`. Sources shorter than 15 s yield one whole-source candidate.
6. **Collapse:** drop any candidate with IoU > 0.5 against a higher-scored one; cap at `maxCandidates`.
7. **Order:** score descending, then `startMs` ascending, so output is stable.
8. **Reason and evidence:** a short sentence built from the contributing numbers ("Audio peak at 01:23, 3.4x the typical level; 2 scene changes; starts after a pause at 01:18") and a small `evidence` object with the same numbers.
9. **No signal:** if there is neither audio nor a scene change, return no candidates and `summary.noSignal = true`; the UI then offers a manual range.

Also export `downsampleEnvelope(rmsDb, maxPoints = 2000)` for the editor timeline.

**Tests:** `packages/domain/src/ranker.test.ts` (unit), including the M2 synthetic peak:

- a 10-minute flat -40 dB envelope with one 6 s burst at 04:00 between two silences -> the top candidate contains 04:00-04:06, is 15-60 s long, starts at the preceding silence end, and names the peak in `reason`;
- two bursts 10 s apart collapse to one candidate; two bursts 3 minutes apart give two;
- no audio plus scene cuts -> candidates with coverage 1/3 and lower confidence;
- no audio and no cuts -> empty with `noSignal`;
- a 9 s source -> one whole-source candidate;
- same input twice -> deep-equal output;
- every candidate lies inside `[0, durationMs]`, and `rank` is 1..n without gaps.

### 5. Fixtures for trim, analysis and captions

**Files:** `packages/media/src/fixtures.ts`, `tests/integration/global-setup.ts`

Add to `FIXTURES` / `generateFixtures`, using the existing `BITEXACT` flags and `x264()` helper, and bump the generator string to `relay-fixtures@2` so cached sets regenerate.

- `timecode-30fps.mp4`: 1280x720, 30 fps, 12 s. Each frame is a solid grey whose luma encodes the frame number (lavfi `geq` or `color` driven by `N`). Tests read a frame's mean luma with `signalstats` instead of OCR, which avoids a font dependency in the fixture. Audio is a sine whose frequency steps every second.
- `timecode-offset.mp4`: the same content with a nonzero container start time (`-output_ts_offset 5`).
- `highlight.mp4`: 90 s at low resolution: quiet tone, a 400 ms silence, a loud burst at 40-46 s with two hard scene cuts (concat of different `color` sources), a silence, then quiet again. This is the end-to-end synthetic peak.
- `timecode-vfr.mp4` (optional, second pass): variable frame rate, to pin the constant-rate output behaviour.

The existing vertical, 721x1279 yuv444p, no-audio square and 90-degree-rotated fixtures are reused as they are.

**Tests:** `pnpm fixtures:generate` twice gives identical SHA-256 for every new file. A small assertion in the integration global setup (or a unit test beside `fixtures.ts`) probes `timecode-offset.mp4` and checks `startTimeMs > 0`.

### 6. Media: feature extraction through the sandbox

**Files:** `packages/media/src/ffmpeg.ts`, `packages/media/src/analysis.ts`, `packages/media/src/analysis.test.ts`, `packages/media/src/index.ts`

`extractFeatures(config, {inputPath, demuxer, scratchDir, hasAudio, durationMs})` in `ffmpeg.ts`, reusing the private `COMMON_INPUT` and `limits` and running through `runToolOrThrow` with `cwd: scratchDir`.

- One FFmpeg process, output `-f null -`, no stdout data (so the 4 MiB stdout kill and the 64 KiB stderr truncation never matter).
- Video chain: `scale=320:-2,fps=5,scdet=threshold=10,metadata=mode=print:key=lavfi.scd.time:file=scene.txt`.
- Audio chain (only when `hasAudio`): `aresample=8000,asetnsamples=n=800:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt`, plus `silencedetect=noise=-35dB:d=0.4` followed by a second `ametadata` print of `lavfi.silence_start` / `lavfi.silence_end` to `silence.txt`.
- Every filter value is a number or a fixed literal. File names are fixed and relative to the scratch directory.
- Limits: the existing timeout and `--as`; `maxFileBytes` sized from duration (about 100 bytes per 100 ms); and `cpuSeconds` set for the first time (`RunLimits` already supports it).

`analysis.ts` holds pure parsers: `parseRmsFile`, `parseSilenceFile`, `parseSceneFile`. They are line-based, tolerate `-inf` and `nan` (mapped to a floor), ignore malformed lines, and cap the number of points. They return the `features` object from step 4.

Export `ANALYZER_VERSION = 'relay-analyze@1'`.

**Tests:** `packages/media/src/analysis.test.ts` (unit): parsers against captured sample text, including `-inf`, a truncated last line and an unterminated silence. Integration (in the file from step 7): `extractFeatures` on `highlight.mp4` reports a silence boundary within 200 ms of each authored gap, both scene cuts within 400 ms, and RMS in 40-46 s at least 12 dB above the rest; on the no-audio square fixture `rmsDb` is null and the call succeeds.

### 7. Service and task: asset.analyze

**Files:** `packages/services/src/analysis.ts`, `packages/services/src/media-pipeline.ts`, `packages/services/src/tasks.ts`, `packages/services/src/jobs.ts`, `packages/services/src/audit.ts`, `packages/services/src/index.ts`, `packages/services/package.json`, `apps/worker/src/main.ts`, `docs/worker-tasks.md`, `tests/integration/clip-analysis.test.ts`

**Shared helpers:** export `toolConfig`, `sanitizeProbe` and the `Rejection` class from `media-pipeline.ts` (or move them to a small `media-common.ts`) so the two new handlers reuse them.

**Commands (app role, `inWorkspace`)**

- `startAnalysis(ctx, user, workspaceId, {assetId}, meta)`:
  1. load the asset; `authorize(member, 'content.create', asset.pageId)`;
  2. require `kind='video'`, `status='ready'`, `origin <> 'render'`, duration within `config.media.analysisMaxSourceSeconds`;
  3. `evaluateRights(... operation: 'edit')` or throw `rights_missing`;
  4. if an active or succeeded analysis exists for the same `(asset, ANALYZER_VERSION, RANKER_VERSION)`, return it (200);
  5. otherwise insert `media_analyses` as `queued`, `createJobRun({kind: 'asset.analyze', entityType: 'media_analysis'})`, `enqueue(tx, 'asset.analyze', {workspaceId, analysisId, correlationId}, {jobKey: 'asset.analyze:<analysisId>', jobKeyMode: 'unsafe_dedupe'})`, `appendAudit` (`analysis.requested`). Return 202 with `jobUrl`.
- `getAnalysis`, `listCandidates(assetId)` (rank order, with reason, confidence and feedback) and `setCandidateFeedback`.

**Worker handler `processAssetAnalysis(ctx, payload, attempt)`**, copying the `processAssetProbe` skeleton:

1. Short `withTenant`: load analysis and asset; skip unless status is `queued` or `running`; re-check `evaluateRights('edit')`, failing with `rights_missing` and no retry; mark `running`.
2. Outside any transaction: `mkdtemp` under `config.media.scratchDir`; download the `proxy/h264-960` variant pinned by `objectVersionId` (fall back to the original with its forced demuxer if no proxy exists); `extractFeatures`; parsers; `rankHighlights`; `downsampleEnvelope`.
3. Final `withTenant`: guarded UPDATE `WHERE status = 'running'`; insert candidates with `onConflict (analysis_id, rank) doNothing`; a `usage_events` row of kind `media_seconds_processed`; `updateJobRun`; `appendAudit` with `SERVICE_ACTORS.media` (`analysis.completed`, data = counts and versions only).
4. `Rejection` -> `failed` with `error_code`; other errors rethrow until `attempt.number >= attempt.max`; `rm` scratch in `finally`.

**Wiring**

- `TASKS['asset.analyze'] = { pool: 'media', schema: {workspaceId, analysisId, correlationId?}, maxAttempts: 3 }`.
- A `case 'asset.analyze'` in `handlers()` in `apps/worker/src/main.ts`.
- `getJobRun`: add a `media_analysis` branch that resolves the asset's page for authorization and returns the analysis status.
- Subpath export `./analysis` in `packages/services/package.json`.

**Rights prerequisite, done here:** make `provider` optional in `evaluateRights` (skip the `permittedProviders` check when absent) and add `revokeRightsGrant(ctx, user, workspaceId, {grantId, reason}, meta)` to `rights.ts`. This is the first item of the status doc's "Next runnable task" and gives the tests a real revoke command.

**Tests:** `tests/integration/clip-analysis.test.ts`, calling `processAssetAnalysis(c.worker, ...)` directly like `uploads.test.ts`:

- **synthetic peak end to end:** upload `highlight.mp4`, `startAnalysis`, run the handler -> status `succeeded`, rank 1 overlaps 40-46 s, length 15-60 s, `rankerVersion` and a non-empty `reason` persisted, job run 100 %;
- running the handler twice inserts no duplicate candidates;
- a second `startAnalysis` returns the existing analysis;
- no-audio fixture succeeds with reduced coverage;
- rights revoked between request and run -> `failed` with `rights_missing`, no candidates;
- a viewer role is refused; another tenant's `assetId` gives `not_found`;
- an asset still `validating` gives `media_not_ready`.

### 8. Media: renderClip (accurate trim, crop, captions, verification)

**Files:** `packages/media/src/ffmpeg.ts`, `packages/media/src/index.ts`, `packages/config/src/env.ts`, `tests/integration/clip-render-ffmpeg.test.ts`

`renderClip(config, {inputPath, demuxer, outputPath, scratchDir, startMs, endMs, geometry, hasAudio, captions: boolean, maxOutputBytes})` beside `renderProxy`, same sandbox.

**Argv**

- `COMMON_INPUT` with `-ss <startMs/1000>` placed before `-i`. When re-encoding, FFmpeg's default accurate seek decodes from the previous keyframe and discards frames before the target, and it accounts for a nonzero container start time. Never `-c copy`.
- `-map 0:v:0 -map 0:a:0?`, `-t <(endMs-startMs)/1000>`, and `-frames:v clipFrameCount(startMs, endMs)` as a hard upper bound.
- Video filter, built from numbers only: `fps=30` -> `scale=<scaleWidth>:<scaleHeight>` -> `crop=...` (fill) or `pad=...` (fit) -> `setsar=1` -> optionally `subtitles=filename=captions.ass:fontsdir=fonts` -> `format=yuv420p`. Autorotation stays on, so geometry uses display dimensions.
- Audio: `aresample=async=1`, AAC 128k stereo 48 kHz; when the source has no audio the output has none (no synthetic silence in v1).
- Encoder: libx264 `-preset veryfast -crf 20 -maxrate 8M -bufsize 16M -g 60 -pix_fmt yuv420p -movflags +faststart`, `-threads config.threads`, and bounded lookahead/refs so 1080x1920 fits the `--as` limit (the fixture helper already uses `rc-lookahead=0:ref=1:bframes=0` for a 512 MB worker; pick the lightest setting that passes the memory test below).
- `-fs maxOutputBytes` plus prlimit `--fsize`, the timeout, `--as`, and `cpuSeconds`.
- `cwd: scratchDir`. The caller writes `captions.ass` from `toAss` and copies the bundled font into `scratchDir/fonts/`. If captions are requested and the fonts directory is missing, throw a typed error; never fall back to a system font.

**Verification:** `verifyClipOutput(config, outputPath, expected)` probes the output with the existing `probeFile` and checks H.264, yuv420p, exact width and height, `nb_frames === clipFrameCount`, AAC present exactly when the source had audio, and `moov` before `mdat` (reuse the box walk in `isobmff.ts`).

**Config additions in `env.ts`:** `RELAY_CLIP_MAX_SECONDS` (default 180), `RELAY_CLIP_MAX_OUTPUT_BYTES`, `RELAY_MEDIA_CPU_SECONDS`, `RELAY_MEDIA_FONTS_DIR`, `RELAY_ANALYSIS_MAX_SOURCE_SECONDS`.

`CLIP_RENDERER_VERSION = 'relay-clip@1'`; the stored `renderer_version` is that prefix plus the FFmpeg version string, as the proxy path does.

**Tests:** `tests/integration/clip-render-ffmpeg.test.ts` (real FFmpeg, no database):

- **exact in/out:** `timecode-30fps.mp4`, `startMs=2000`, `endMs=5000` -> exactly 90 frames; first frame's luma decodes to source frame 60, last to frame 149 (`endMs` exclusive);
- a start that is not on a keyframe (`startMs=2333`) gives first frame 70;
- `timecode-offset.mp4` gives the same frame numbers as the zero-start file;
- **odd sizes:** 721x1279 yuv444p with `original` -> 720x1278 yuv420p;
- **no audio:** square fixture -> video only, verification passes;
- **rotation:** 90-degree fixture, 9:16 fill -> portrait output, no rotation tag, top-left colour sample matches the expected orientation;
- **fit vs fill:** landscape to 9:16: fit has black bars at the top and bottom rows, fill does not;
- **captions:** a cue over 1-2 s makes the lower-third region of a frame at 1.5 s differ from the uncaptioned render, and a frame at 2.5 s equal;
- a cue containing `{\\an8}` and `'[in]` renders without an FFmpeg error;
- faststart: `moov` precedes `mdat`;
- a tiny `maxOutputBytes` fails with a `ToolError` and leaves no partial upload;
- a 1080x1920 render completes under the configured memory limit.

### 9. Service: clip projects and revisions (non-destructive editing)

**Files:** `packages/services/src/clips.ts`, `packages/services/src/index.ts`, `tests/integration/clips.test.ts`

All in `inWorkspace`, authorised against the source asset's page.

- `createClip(ctx, user, workspaceId, input, meta)`: `withIdempotency`; `content.create`. The source must be a `ready` video with `origin <> 'render'`; `evaluateRights('edit')`. The range comes from `candidateId` (which must belong to the same asset; mark the candidate `accepted`) or from an explicit `startMs`/`endMs`. Run `validateClipRange`. Insert `clip_projects` and revision 1 (defaults: `9:16`, `fill`, no captions); `appendAudit` (`clip.created`).
- `updateClip(..., clipId, input, meta)`: `content.edit`. Optimistic `version`, with `version_conflict` on mismatch, as posts do. Validate the range, `validateCues` against the new range, and the 128 KiB caption cap. Insert a new immutable `clip_revisions` row with `edit_hash = clipEditHash(...)`, bump `version`, and move `current_revision_id`. If the hash equals the current revision's, return it unchanged. When the range differs from the originating candidate, set that candidate's feedback to `trim_adjusted`.
- `importCaptions(..., clipId, {format, text, relativeTo})`: parse with `parseSrt`/`parseVtt`, shift, validate, and return cues for the editor. It does not persist; saving goes through `updateClip`.
- `getClip` (project, current revision, source summary with display dimensions and duration, latest render and its output asset status, and the computed `clipGeometry`), and `listClips({pageId, sourceAssetId})`.

The source asset is never written.

**Tests:** `tests/integration/clips.test.ts`:

- create from a candidate and from a manual range; idempotent replay returns 200 with the same IDs;
- `updateClip` creates revision 2 and leaves revision 1 byte-identical;
- a stale `version` gives `version_conflict`;
- `endMs` past the source duration gives a field error;
- an overlapping cue is rejected with its index;
- an identical edit creates no new revision;
- a source without an edit grant gives `rights_missing`;
- a clip of a rendered asset is refused;
- a page-restricted member without access and a foreign tenant both get `not_found`.

### 10. Service and task: clip.render into a derived asset with inherited rights

**Files:** `packages/services/src/clip-render.ts`, `packages/services/src/rights.ts`, `packages/services/src/tasks.ts`, `packages/services/src/jobs.ts`, `packages/services/src/assets.ts`, `packages/services/src/index.ts`, `packages/services/package.json`, `apps/worker/src/main.ts`, `docs/worker-tasks.md`, `tests/integration/clip-render.test.ts`

**`requestClipRender(ctx, user, workspaceId, clipId, input, meta)`** (app role, one `inWorkspace` transaction, `withIdempotency`, `content.create`):

1. Load the clip, the revision (requested or current) and the source; require the source `ready`.
2. `evaluateRights('edit')` on the source, else `rights_missing`.
3. Compute `renderKey`. If a `queued`, `running` or `succeeded` job has it, return that job (200, same output asset).
4. Take the per-workspace quota advisory lock used by `startUpload` and check `workspaceStorageUsage` plus `reservedBytes` (clip duration times the bitrate cap, bounded by `clipMaxOutputBytes`), else `quota_exceeded`.
5. Insert the output `media_assets` row: new ID, same `page_id`, `kind='video'`, `status='validating'`, `origin='render'`, `object_key = assetOriginalKey(ws, newAssetId, 1, 'mp4')`, `declared_mime='video/mp4'`, `size_bytes = reservedBytes`, `is_sample` copied from the source, `original_filename` derived from the clip title.
6. Insert `render_jobs` (`queued`, with `source_rights_version`), `createJobRun({kind: 'clip.render', entityType: 'render_job'})`, `enqueue(tx, 'clip.render', {workspaceId, renderJobId, correlationId}, {jobKey: 'clip.render:<renderJobId>', jobKeyMode: 'unsafe_dedupe'})`, `appendAudit` (`clip.render_requested`). Return 202 with `jobUrl` and `outputAssetId`.

**`processClipRender(ctx, payload, attempt)`** (worker):

1. Short `withTenant`: load job, revision, source and output asset; skip unless the job is `queued`/`running` and the output asset is `validating`. **Re-check rights** with `evaluateRights('edit')` on the source at `ctx.clock.now()`; if not ok, fail permanently. Mark `running`.
2. Scratch directory. Download the original pinned by `objectVersionId` and `objectEtag` with `maxBytes`. Re-run `sniffContainer`, `scanIsoBmffProtection`, `probeFile` and `validateProbe`, so the renderer never trusts stored metadata. Compute `clipGeometry`. Write `captions.ass` from `cuesForRender` and `toAss`. `renderClip`, then `verifyClipOutput`.
3. `renderThumbnail` and `renderProxy` on the output, so the clip previews in the post editor and calendar like any upload.
4. `uploadFile` the MP4 to the pre-assigned key and the two variants, each with the `head` fallback used in `processAssetProbe`, so a retry after a crash is idempotent (keys are write-once).
5. Final `withTenant`: check rights a second time (a revoke during a long render must not produce a ready asset). Guarded UPDATE of the output asset `WHERE status = 'validating'` setting sha256, the real `size_bytes`, dimensions, duration, codecs, probe, `ffprobe_version`, `status='ready'`, `validated_at = ctx.clock.now()`. Insert the variants. Update the job to `succeeded` with `output_probe`, `renderer_version` and `render_ms`. Write `usage_events` for `media_seconds_processed` and `export_bytes`, `updateJobRun`, and `appendAudit` (`clip.rendered`).
6. Permanent failure (`Rejection`, verification failure, rights): output asset -> `rejected` with a `rejection_code` (`render_failed`, `rights_revoked`, `source_changed`), job -> `failed`, uploaded objects removed with `deleteAllVersions`. Other errors rethrow for a queue retry until the last attempt. Scratch is removed in `finally`.

**Rights inheritance in `evaluateRights`:** before loading grants, map each requested asset through `render_jobs.output_asset_id -> source_asset_id`. Derived assets are evaluated against the source's grants and additionally need `canEdit`. Problems and grants are reported under the derived asset's ID. Publishing a clip therefore passes through the existing calls in `intents.ts` with no change there, and the trigger from step 1 bumps the clip's `rights_version`.

**Wiring**

- `TASKS['clip.render']` (`pool: 'media'`, `maxAttempts: 3`) and its `case` in `handlers()`.
- `getJobRun` branch for `render_job`.
- `mediaUrl` in `assets.ts`: before presigning, call `evaluateRights('view')`, or `'export'` for attachment downloads, so preview and export URLs of clips and sources obey rights (spec 6.5).
- `exportClip(ctx, user, workspaceId, clipId, meta)`: `content.export`, `evaluateRights('export')`, short-lived attachment `presignGet`, `appendAudit` (`clip.exported`).

**Tests:** `tests/integration/clip-render.test.ts`, driving `processClipRender(c.worker, ...)` directly:

- **happy path:** `timecode-30fps.mp4`, clip 2000-5000 ms, 9:16 fill -> job `succeeded`; output asset `ready` with `origin='render'`, the source's `page_id`, a sha256, 90 frames, H.264/AAC/yuv420p, thumbnail and proxy variants; the source row and object are unchanged (same sha256 and version ID);
- **idempotent:** the same request twice returns the same job and asset; running the handler twice uploads once and leaves one set of variants;
- **new revision** -> a new render key and a new asset; the first asset is untouched;
- **odd size, no audio and rotation** each through the full service path;
- **rights revoked before the render:** `revokeRightsGrant`, then the handler -> job `failed` with `rights_revoked`, asset `rejected`, no object left in the bucket;
- **rights revoked after the render:** `evaluateRights('publish')` on the clip is not ok, the clip's `rights_version` has increased, and `mediaUrl` and `exportClip` both throw `rights_missing`;
- **quota:** a workspace at its limit gets `quota_exceeded` and no rows; after a failed render the reservation no longer counts;
- `is_sample` propagates from a sample source;
- cross-tenant `clipId` -> `not_found`; a viewer cannot render.

Also extend `tests/integration/reliability.test.ts` to use `revokeRightsGrant` in place of the direct UPDATE.

### 11. Handoff to a draft post and the approval / schedule flow

**Files:** `packages/services/src/clips.ts`, `tests/integration/clip-handoff.test.ts`

No new publishing path. `createPostFromClip(ctx, user, workspaceId, clipId, {destinationIds?, caption?}, meta)` is a thin wrapper: it requires the latest render to be `succeeded` and its output asset `ready`, then calls the existing `createPost` with `pageId` of the clip and `mediaAssetIds: [outputAssetId]`, and records `clip.handed_off` in the audit log with the post ID.

The web client may equally call `POST /posts` directly, as `createDraft()` in `UploadFlow.tsx` does. The wrapper exists so the lineage is audited and so the "render not finished" error is specific.

`loadAssetsForRevision` in `posts.ts` already accepts any non-rejected asset on the same page, so no change is needed there. `intents.ts` already calls `evaluateRights` at approval, scheduling and dispatch, and step 10 made that lineage-aware.

**Tests:** `tests/integration/clip-handoff.test.ts`:

- render a clip, `createPostFromClip`, then run the existing `approvedPost` / `drivePublishing` helpers against the simulator -> the post publishes (simulated) with the clip asset, and the result is still labelled simulated;
- **rights revoked after scheduling** (the M2 gate item): schedule the clip post, revoke the source grant, advance the worker -> the destination is blocked with the rights problem and nothing is sent to the simulator;
- handoff before the render finishes -> `media_not_ready`;
- handoff of a clip whose render failed -> the same error and no post row.

### 12. API routes (thin)

**Files:** `apps/web/src/app/api/v1/workspaces/[workspaceId]/assets/[assetId]/analyses/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/assets/[assetId]/candidates/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/candidates/[candidateId]/feedback/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/clips/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/clips/[clipId]/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/clips/[clipId]/captions/import/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/clips/[clipId]/renders/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/clips/[clipId]/exports/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/clips/[clipId]/posts/route.ts`, `apps/web/e2e/security.spec.ts`

Each file is `export const VERB = api<P>({}, async (c) => service(c.ctx, c.user, c.params.workspaceId, ..., meta(c)))`, matching the spec section 5 names where they exist.

- `POST assets/:assetId/analyses` -> `startAnalysis` (202 with `jobUrl`, or 200 for an existing one).
- `GET assets/:assetId/candidates` -> `listCandidates` (includes the analysis status and envelope).
- `POST candidates/:candidateId/feedback` -> `setCandidateFeedback`.
- `POST clips` -> `createClip` (`ApiResponse(body, replayed ? 200 : 201)`); `GET clips` -> `listClips`.
- `GET clips/:clipId` -> `getClip`; `PATCH clips/:clipId` -> `updateClip`.
- `POST clips/:clipId/captions/import` -> `importCaptions`. The 256 KiB body cap in `api()` already bounds the SRT/VTT text.
- `POST clips/:clipId/renders` -> `requestClipRender` (202).
- `POST clips/:clipId/exports` -> `exportClip`.
- `POST clips/:clipId/posts` -> `createPostFromClip`.

Progress uses the existing `GET /jobs/:jobId`. The editor video uses the existing `GET /assets/:assetId/url?variant=proxy`.

**Tests:** Extend `apps/web/e2e/security.spec.ts`: cross-tenant `clipId`, `candidateId` and `assetId` on every new route return 404; a mutation without the CSRF header is refused; a non-UUID ID returns 404. Route behaviour itself is covered by the service integration tests.

### 13. Web UI: Find clips, candidates, clip editor, render and handoff

**Files:** `apps/web/src/app/w/[slug]/find-clips/page.tsx`, `apps/web/src/app/w/[slug]/find-clips/[assetId]/page.tsx`, `apps/web/src/app/w/[slug]/find-clips/loading.tsx`, `apps/web/src/app/w/[slug]/clips/[clipId]/page.tsx`, `apps/web/src/components/clips/SourceList.tsx`, `apps/web/src/components/clips/CandidateList.tsx`, `apps/web/src/components/clips/ClipEditor.tsx`, `apps/web/src/components/clips/TrimBar.tsx`, `apps/web/src/components/clips/CropPreview.tsx`, `apps/web/src/components/clips/CaptionEditor.tsx`, `apps/web/src/components/clips/RenderPanel.tsx`, `apps/web/src/components/upload/UploadFlow.tsx`, `apps/web/src/app/globals.css`, `apps/web/e2e/clip-flow.spec.ts`, `apps/web/e2e/accessibility.spec.ts`

Thin server pages (`loadWorkspace` plus one service read, `perms` computed with `can()`), client components with serialisable props, tokens and `r-*` classes only.

- **`find-clips/page.tsx`** replaces the placeholder: a list of the page's ready videos (`origin='upload'`) with thumbnail, duration and analysis state, a primary "Upload a video" action, and `EmptyState` when empty. Honour `?page=`.
- **`UploadFlow`**: accept `?intent=clips`; after the asset is `ready`, call `POST /assets/:id/analyses` and go to `find-clips/:assetId` instead of the compose phase.
- **`find-clips/[assetId]`**: `ProgressBar` and a `role="status"` line fed by `poll(() => apiFetch('/jobs/:id'))` (never `router.refresh()` polling). Then an ordered list of candidates: rank, tabular time range, length, a confidence `Badge`, and the persisted reason. Label them "Suggested". Actions per candidate: "Edit clip" (`POST /clips`), "Not useful" feedback. Also "Create a clip from a manual range", and a `noSignal` message that points to it.
- **`clips/[clipId]` -> `ClipEditor`**:
  - `<video>` on the source proxy, looping inside `[startMs, endMs)`.
  - `TrimBar`: the stored envelope drawn as a waveform, with two `role="slider"` thumbs (`aria-valuetext` such as "In 01:23.4", arrow keys 0.1 s, Shift+arrow 1 s, Home/End), 44 px hit areas, numeric timecode inputs and "Set in / out to playhead" buttons as the non-drag alternative.
  - Aspect `r-select` (9:16, 1:1, original) and a fit / fill radio `fieldset`.
  - `CropPreview` positions the video with CSS from `clipGeometry` in `@relay/domain`, the same function the renderer uses.
  - `CaptionEditor`: cue rows (start, end, text), add and remove, SRT/VTT import through the import route, errors through `Field error`, and cues overlaid on the preview at the right times.
  - Save: `PATCH /clips/:id` with `version`; on `version_conflict` show the same reload prompt as `PostWorkspace`.
  - `RenderPanel`: `POST /clips/:id/renders` with `newIdempotencyKey('render')`, poll the job into a `ProgressBar`, toast on completion, then show the rendered MP4, "Download" (exports route) and "Create draft post" (`POST /clips/:id/posts`, then `router.push` to `/w/:slug/posts/:postId`).
- Show `SampleBadge` when the source is a sample. Add `find-clips/loading.tsx` with `Skeleton` so these pages paint immediately.
- CSS classes `clip-editor`, `trim-bar`, `trim-thumb`, `crop-stage`, `cue-row` in `globals.css`, stacked below 960 px, both themes.

Optional follow-up on the candidates page: "Render top 3", which calls `POST /clips` and `POST /renders` per candidate. It only composes existing commands and still ends in drafts that need approval.

**Tests:** `apps/web/e2e/clip-flow.spec.ts` (desktop project, real worker): sign in as a demo editor, upload the `highlight.mp4` fixture with the clips intent, wait for candidates, open the first, nudge the out point with the keyboard, add one caption, render, wait for completion, create the draft post, and assert the post editor shows the clip's media tile.

Extend `accessibility.spec.ts`: both trim thumbs are reachable by Tab, arrow keys change `aria-valuenow`, the numeric fields stay in sync, and the editor passes the existing dark-theme check.

Unit: a small test that `CropPreview`'s style helper and `clipGeometry` agree for the geometry table from step 2.

### 14. Runtime, seed and documentation

**Files:** `infra/docker/worker.Dockerfile`, `packages/services/src/seed.ts`, `packages/services/src/maintenance.ts`, `docs/implementation-status.md`, `docs/worker-tasks.md`, `docs/testing-guide.md`, `.env.example`

- **Font:** install `fonts-inter` (SIL OFL 1.1) in the runtime stage of the worker Dockerfile and set `RELAY_MEDIA_FONTS_DIR=/usr/share/fonts/opentype/inter`. The local box already has Inter at that path. Record the licence in the status doc. The ASS style names the family explicitly, and a missing directory makes caption renders fail rather than fall back.
- **Stuck work:** extend `maintenance.cleanup` (general pool, no FFmpeg) to find `render_jobs` and `media_analyses` stuck in `queued`/`running` past the media timeout via `withMaintenanceScope`, then per tenant mark them failed and move the reserved output asset to `rejected`, releasing the quota.
- **Seed:** add one analysed sample source with candidates to the Fernhill demo tenant by running the real handlers at seed time, with `is_sample` set, so the demo shows the clipper flow. The spec's "three usable clips" example can follow once render time on the staging worker is known.
- **Docs:** tick the delivered M2 items in `docs/implementation-status.md`, list what remains (URL resolver, alignment, manual crop, sidecar export, stream signals), record commands run and evidence, and update the "Next runnable task". Document `asset.analyze` and `clip.render` in `docs/worker-tasks.md` and the new variables in `.env.example`.
- **Checks to run at the end:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm format:check`, `pnpm db:types:check`.

**Tests:** Integration: a maintenance test that ages a `running` render job with `ManualClock`, runs cleanup and sees the job `failed`, the asset `rejected` and the quota freed. Seed test: after `pnpm db:seed` the demo tenant has a succeeded analysis with at least one candidate, all on a sample asset. Container: a CI image job step that runs `fc-list | grep -i inter` inside the built worker image.

## Migrations

- `packages/db/migrations/0013_clipping.sql` (new; 0001-0012 are not edited). Creates `media_analyses`, `clip_candidates`, `clip_projects`, `clip_revisions` (immutable via `relay_forbid_mutation`) and `render_jobs`, each with `workspace_id NOT NULL`, `UNIQUE (workspace_id, id)`, composite tenant FKs and `relay_apply_tenant_rls`.
- Same file: partial unique indexes for one active analysis per `(asset_id, analyzer_version, ranker_version)` and one active or successful render per `(workspace_id, render_key)`; `UNIQUE (output_asset_id)` on `render_jobs`.
- Same file: function `relay_bump_derived_rights_version()` and trigger `source_rights_grants_bump_derived` on `source_rights_grants`, which bumps `media_assets.rights_version` of every clip rendered from the affected source.
- Same file, grants: `relay_app` gets SELECT/INSERT on `media_analyses`, `clip_projects`, `clip_revisions`, `render_jobs`; SELECT plus UPDATE (`feedback, feedback_by, feedback_at`) on `clip_candidates`; UPDATE (`title, current_revision_id, version, archived_at, updated_at`) on `clip_projects`. `relay_worker` gets SELECT on all five, INSERT on `clip_candidates`, and column-level UPDATE of status/result columns on `media_analyses` and `render_jobs`.
- Same file: `GRANT UPDATE (size_bytes) ON media_assets TO relay_worker` so the worker can replace the reserved size with the real one while the row is still `validating`; `relay_apply_maintenance_scan` on `render_jobs` and `media_analyses`.
- Set `REQUIRED_SCHEMA_VERSION = '0013'` in `packages/db/src/schema-version.ts`, run `pnpm db:types`, commit `packages/db/src/generated/db.ts`.
- No change to the `media_variants.kind` CHECK and no change to `media_assets.origin` (it already allows `render`).

## Operator actions

- Run the migration on any shared or hosted database (`node dist/migrate.js` in the worker image, or `pnpm db:migrate`). Web and worker refuse to start against schema 0012 once this code is deployed, so migrate first.
- Rebuild and redeploy the worker image: it gains the `fonts-inter` package and the two new tasks. Deploying is the owner's action.
- Set the new variables where defaults do not fit: `RELAY_MEDIA_FONTS_DIR`, `RELAY_CLIP_MAX_SECONDS`, `RELAY_CLIP_MAX_OUTPUT_BYTES`, `RELAY_MEDIA_CPU_SECONDS`, `RELAY_ANALYSIS_MAX_SOURCE_SECONDS`.
- Decide the media pool size on the hosted worker. `RELAY_MEDIA_CONCURRENCY` defaults to 1, so a long analysis blocks renders and upload validation behind it; raising it needs matching memory (about 2 GB address space per FFmpeg process at the default limit).
- Confirm the Inter font licence (SIL OFL 1.1) is acceptable for burned-in captions; the spec asks for a recorded licence review.

## Risks

- **Frame-exact trim.** The plan uses input-side `-ss` with FFmpeg's accurate seek plus `-t` and a `-frames:v` bound. If the timecode tests show an off-by-one on the offset-start or non-keyframe cases, switch to `trim`/`atrim` with `setpts=PTS-STARTPTS` after a coarse input seek. The integration test in step 8 decides; do not ship without it green.
- **Sources that are not 30 fps.** Output is forced to 30 fps, so on 24/25/60 fps or variable-rate sources `startMs` maps to the nearest resampled frame, not a source frame. Exactness is only asserted on the 30 fps fixture; a VFR fixture is listed as a second pass.
- **Memory under `prlimit --as`.** 1080x1920 x264 with default lookahead can exceed the 2048 MB address-space limit, and the hosted worker may be far smaller (the fixtures were tuned for 512 MB). Encoder settings must be chosen by the memory test, at some cost in quality per bit.
- **Queue contention.** With one media slot, a multi-hour analysis delays every render and every upload validation. Analysis reads the 960 px proxy and decodes video at 320 px / 5 fps to limit this, but analysis time per hour of source was not measured.
- **Caption rendering inside the sandbox.** The child process has only `PATH` and `LC_ALL=C` and no `HOME`; libass/fontconfig may warn or fail to find fonts even with `fontsdir`. If so, the fix is a minimal fontconfig file in the scratch directory, not widening the environment.
- **Output asset inserted as `validating`.** The lifecycle guard only fires on UPDATE, so inserting directly at `validating` works, but any code that assumes every `validating` asset has an `upload_sessions` row (for example `maintenance.expire_uploads` or `getJobRun`) must be checked when implementing step 10.
- **Rights lineage changes `evaluateRights` for every caller.** The extra lookup through `render_jobs` runs on approve, schedule and dispatch. It is one indexed query, but it touches the publishing path, so the full existing publishing and reliability suites must stay green.
- **`mediaUrl` gains a rights check.** Assets whose only grant has `can_view = false`, or seeded sample assets without a grant, would stop previewing. Check the seed data before enabling it.
- **Ranker quality.** Audio energy, onsets and scene cuts find loud or busy moments, not necessarily good ones. Candidates are labelled suggestions, and the manual range path must always work. Sources with neither audio nor cuts return no candidates by design.
- **Scope against the user's request.** This delivers upload -> clip -> draft -> approve -> schedule on simulated connections. Posting to real Meta or other platforms still depends on M3/M4 work, provider app review and operator credentials, and is not unlocked by this plan.

## Cannot be verified in the development environment

- Nothing was executed against Postgres, S3 or FFmpeg in this session; all SQL, argv and filter chains above are designs, not tested commands.
- Whether `scdet`, `astats`/`ametadata` and `silencedetect` metadata keys print exactly as assumed (`lavfi.scd.time`, `lavfi.astats.Overall.RMS_level`, `lavfi.silence_start`/`lavfi.silence_end`) on FFmpeg 6.1.1; the media map confirms the filters exist, not their output format.
- Whether `relay_bump_rights_version` in 0005 is SECURITY DEFINER or invoker; the new derived-rights trigger should match it and I did not read that function body.
- Whether `fonts-inter` installs cleanly in the pinned Ubuntu 24.04 runtime image and where it places files; the path is taken from the local box only.
- Whether `maintenance.expire_uploads`, `workspaceStorageUsage` callers or `getJobRun` make assumptions that break for a `validating` asset with no upload session; I read only the usage query.
- Analysis and render wall-clock time and memory on the hosted worker; needed to judge the 'no lag' goal and the right `RELAY_MEDIA_CONCURRENCY`.
- The end-to-end browser flow (Playwright) and the worker image build cannot be run in a read-only planning pass.
