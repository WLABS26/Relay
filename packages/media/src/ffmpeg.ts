import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CAPTION_FONT_FAMILY,
  CLIP_FPS,
  clipFrameCount,
  type ClipGeometry,
  type ProbeStream,
  type ProbeSummary,
} from '@relay/domain';
import { buildFeatures, RMS_HOP_MS, type MediaFeatures } from './analysis';
import { isFastStartMp4 } from './isobmff';
import { runTool, runToolOrThrow, ToolError, type RunLimits } from './process';

/**
 * FFmpeg/ffprobe invocations built from typed inputs. Inputs are always local scratch files
 * written by Relay; the protocol whitelist forbids network and nested-file protocols, and the
 * demuxer is forced from the sniffed container so a mislabeled file (for example an HLS
 * playlist renamed to .mp4) cannot select a different demuxer.
 */

export interface MediaToolConfig {
  ffmpegPath: string;
  ffprobePath: string;
  timeoutSeconds: number;
  memoryLimitMb: number;
  threads: number;
  usePrlimit: boolean;
  /**
   * CPU-time cap for long decodes (prlimit --cpu). Defaults to the wall-clock timeout times the
   * thread count, which only ever fires on a process that is spinning rather than waiting.
   */
  cpuSeconds?: number;
}

/** Demuxers permitted for uploads. */
export const DEMUXER_WHITELIST =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,jpeg_pipe,png_pipe,webp_pipe,image2';

const PROTOCOL_WHITELIST = 'file';

function limits(config: MediaToolConfig, overrides: Partial<RunLimits> = {}): RunLimits {
  return {
    timeoutMs: config.timeoutSeconds * 1000,
    memoryLimitMb: config.memoryLimitMb,
    usePrlimit: config.usePrlimit,
    ...overrides,
  };
}

function ratio(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [n, d] = value.split('/').map(Number);
  if (!n || !d || !Number.isFinite(n) || !Number.isFinite(d)) return null;
  return Math.round((n / d) * 1000) / 1000;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

const ENCRYPTED_TAGS = new Set(['encv', 'enca', 'enct', 'encs', 'drmi', 'drms']);

/** Parse `ffprobe -of json -show_format -show_streams` output into Relay's summary. */
export function parseProbeJson(json: unknown): ProbeSummary {
  const root = (json ?? {}) as {
    format?: Record<string, unknown>;
    streams?: Array<Record<string, unknown>>;
  };
  const format = root.format ?? {};
  let encrypted = false;
  const streams: ProbeStream[] = (root.streams ?? []).map((s) => {
    const type =
      (['video', 'audio', 'subtitle', 'data', 'attachment'] as const).find(
        (t) => t === s.codec_type,
      ) ?? 'unknown';
    const tag = typeof s.codec_tag_string === 'string' ? s.codec_tag_string : null;
    if (tag && ENCRYPTED_TAGS.has(tag)) encrypted = true;
    const sideData = Array.isArray(s.side_data_list)
      ? (s.side_data_list as Array<Record<string, unknown>>)
      : [];
    if (
      sideData.some(
        (d) => typeof d.side_data_type === 'string' && /encryption/i.test(d.side_data_type),
      )
    )
      encrypted = true;
    const displayMatrix = sideData.find(
      (d) => typeof d.rotation === 'number' || typeof d.rotation === 'string',
    );
    const tags = (s.tags ?? {}) as Record<string, unknown>;
    // ffprobe reports display-matrix rotation counter-clockwise (e.g. -90); normalise to 0..359 clockwise.
    const rawRotation = num(displayMatrix?.rotation) ?? num(tags.rotate) ?? 0;
    const rotation = ((Math.round(-rawRotation) % 360) + 360) % 360;
    const disposition = (s.disposition ?? {}) as Record<string, unknown>;
    const stream: ProbeStream = {
      index: num(s.index) ?? 0,
      type,
      codec: typeof s.codec_name === 'string' ? s.codec_name : null,
      codecTag: tag,
      pixFmt: typeof s.pix_fmt === 'string' ? s.pix_fmt : null,
      avgFrameRate: ratio(s.avg_frame_rate),
      realFrameRate: ratio(s.r_frame_rate),
      rotation: type === 'video' ? rotation : 0,
      durationMs: num(s.duration) !== null ? Math.round(num(s.duration)! * 1000) : null,
      startTimeMs: num(s.start_time) !== null ? Math.round(num(s.start_time)! * 1000) : null,
      attachedPic: disposition.attached_pic === 1,
    };
    const width = num(s.width);
    const height = num(s.height);
    if (width) stream.width = width;
    if (height) stream.height = height;
    const channels = num(s.channels);
    const sampleRate = num(s.sample_rate);
    if (channels) stream.channels = channels;
    if (sampleRate) stream.sampleRate = sampleRate;
    return stream;
  });
  const duration = num(format.duration);
  const start = num(format.start_time);
  return {
    formatName: typeof format.format_name === 'string' ? format.format_name : 'unknown',
    durationMs: duration !== null ? Math.round(duration * 1000) : null,
    startTimeMs: start !== null ? Math.round(start * 1000) : null,
    bitRate: num(format.bit_rate),
    streams,
    encrypted,
  };
}

export async function ffprobeVersion(config: MediaToolConfig): Promise<string> {
  const result = await runTool(
    config.ffprobePath,
    ['-hide_banner', '-version'],
    limits(config, { timeoutMs: 10_000 }),
  );
  return result.stdout.toString('utf8').split('\n')[0]?.trim().slice(0, 120) ?? 'unknown';
}

export async function probeFile(
  config: MediaToolConfig,
  inputPath: string,
  demuxer: string,
): Promise<ProbeSummary> {
  const args = [
    '-v',
    'error',
    '-hide_banner',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    DEMUXER_WHITELIST,
    '-f',
    demuxer,
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    '-i',
    inputPath,
  ];
  const result = await runTool(
    config.ffprobePath,
    args,
    limits(config, { timeoutMs: Math.min(config.timeoutSeconds * 1000, 120_000) }),
  );
  if (result.timedOut) throw new ToolError('ffprobe timed out', result);
  if (result.code !== 0)
    throw new ToolError(
      `ffprobe could not read the file: ${result.stderr.trim().slice(0, 200)}`,
      result,
    );
  let json: unknown;
  try {
    json = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw new ToolError('ffprobe returned malformed JSON', result);
  }
  const summary = parseProbeJson(json);
  // Stream-level fields hide content protection; packet side data exposes it for any container.
  if (!summary.encrypted && (await firstPacketsEncrypted(config, inputPath, demuxer))) {
    summary.encrypted = true;
  }
  return summary;
}

/** True when any of the first packets carries encryption side data (CENC, WebM encryption). */
async function firstPacketsEncrypted(
  config: MediaToolConfig,
  inputPath: string,
  demuxer: string,
): Promise<boolean> {
  const args = [
    '-v',
    'quiet',
    '-hide_banner',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    DEMUXER_WHITELIST,
    '-f',
    demuxer,
    '-read_intervals',
    '%+#3',
    '-show_packets',
    '-show_entries',
    'packet=stream_index:packet_side_data=side_data_type',
    '-of',
    'json',
    '-i',
    inputPath,
  ];
  const result = await runTool(config.ffprobePath, args, limits(config, { timeoutMs: 30_000 }));
  if (result.code !== 0 || result.timedOut) return false;
  try {
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      packets?: Array<{ side_data_list?: Array<{ side_data_type?: string }> }>;
    };
    return (parsed.packets ?? []).some((p) =>
      (p.side_data_list ?? []).some(
        (d) => typeof d.side_data_type === 'string' && /encryption/i.test(d.side_data_type),
      ),
    );
  } catch {
    return false;
  }
}

const COMMON_INPUT = (demuxer: string, inputPath: string) => [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-protocol_whitelist',
  PROTOCOL_WHITELIST,
  '-format_whitelist',
  DEMUXER_WHITELIST,
  '-f',
  demuxer,
  '-i',
  inputPath,
];

/** JPEG poster/thumbnail, longest side ≤ maxSide, display orientation applied. */
export async function renderThumbnail(
  config: MediaToolConfig,
  input: {
    path: string;
    demuxer: string;
    kind: 'video' | 'image';
    durationMs: number | null;
    outputPath: string;
    maxSide: number;
  },
): Promise<void> {
  const seekSeconds =
    input.kind === 'video' && input.durationMs ? Math.min(1, input.durationMs / 2000) : 0;
  const scale = `scale=w='min(${input.maxSide},iw)':h='min(${input.maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const args = [
    ...(seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : []),
    ...COMMON_INPUT(input.demuxer, input.path),
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    scale,
    '-q:v',
    '4',
    '-threads',
    String(config.threads),
    '-f',
    'image2',
    '-c:v',
    'mjpeg',
    '-y',
    input.outputPath,
  ];
  await runToolOrThrow(config.ffmpegPath, args, limits(config, { maxFileBytes: 20 * 1024 * 1024 }));
}

/**
 * Playback proxy: H.264/AAC MP4, yuv420p, longest side ≤ maxSide, constant frame rate, fast
 * start. Decodes the whole input, which doubles as a full decodability check. Audio is mapped
 * only if present.
 */
export async function renderProxy(
  config: MediaToolConfig,
  input: {
    path: string;
    demuxer: string;
    outputPath: string;
    maxSide: number;
    maxOutputBytes: number;
  },
): Promise<void> {
  const scale = `scale=w='min(${input.maxSide},iw)':h='min(${input.maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const args = [
    ...COMMON_INPUT(input.demuxer, input.path),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `${scale},fps=30`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-threads',
    String(config.threads),
    '-fs',
    String(input.maxOutputBytes),
    '-f',
    'mp4',
    '-y',
    input.outputPath,
  ];
  await runToolOrThrow(
    config.ffmpegPath,
    args,
    limits(config, { maxFileBytes: input.maxOutputBytes + 1024 * 1024 }),
  );
}

/** Side files written by the extraction graph, relative to the scratch directory. */
const FEATURE_FILES = {
  scene: 'scene.txt',
  rms: 'rms.txt',
  silenceStart: 'silence-start.txt',
  silenceEnd: 'silence-end.txt',
} as const;

/** One printed frame is a header plus one value line: about 90 bytes, sized with headroom. */
const FEATURE_BYTES_PER_HOP = 160;
const FEATURE_FILE_FLOOR_BYTES = 1024 * 1024;

const FEATURE_VIDEO_CHAIN = [
  // Dropping to 5 fps before scaling means only one frame in six is ever scaled.
  'fps=5',
  'scale=320:-2',
  'scdet=threshold=10',
  `metadata=mode=print:key=lavfi.scd.time:file=${FEATURE_FILES.scene}`,
].join(',');

const FEATURE_AUDIO_CHAIN = [
  'aresample=8000',
  // 800 samples at 8 kHz: one astats measurement per 100 ms hop (RMS_HOP_MS).
  'asetnsamples=n=800:p=0',
  'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level',
  `ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${FEATURE_FILES.rms}`,
  'silencedetect=noise=-35dB:d=0.4',
  // A keyed print writes one key, and two prints cannot share a file, so starts and ends go
  // to separate files and are joined after the run.
  `ametadata=mode=print:key=lavfi.silence_start:file=${FEATURE_FILES.silenceStart}`,
  `ametadata=mode=print:key=lavfi.silence_end:file=${FEATURE_FILES.silenceEnd}`,
].join(',');

/** Read at most `maxBytes` of a side file; a missing file reads as empty. */
async function readSideFile(filePath: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    // Sized from the file, not the limit: the limit is tens of megabytes for long sources.
    const size = Math.min((await handle.stat()).size, maxBytes);
    const buffer = Buffer.alloc(size);
    let length = 0;
    while (length < size) {
      const { bytesRead } = await handle.read(buffer, length, size - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Audio level, silences and scene changes of a video, in one decode pass.
 *
 * The process writes nothing to stdout (`-f null -`) and prints per-frame metadata to fixed,
 * relative file names inside `scratchDir`, which is its working directory. Every filter
 * argument is a constant, so nothing derived from the upload reaches the filter graph.
 * Timestamps are on the 0-based media timeline: FFmpeg subtracts the container start time
 * before filtering.
 */
export async function extractFeatures(
  config: MediaToolConfig,
  input: {
    inputPath: string;
    demuxer: string;
    scratchDir: string;
    hasAudio: boolean;
    durationMs: number;
  },
): Promise<MediaFeatures> {
  const hops = Math.ceil(Math.max(input.durationMs, 0) / RMS_HOP_MS);
  const maxFileBytes = Math.max(FEATURE_FILE_FLOOR_BYTES, hops * FEATURE_BYTES_PER_HOP);
  const args = [
    ...COMMON_INPUT(input.demuxer, path.resolve(input.inputPath)),
    '-map',
    '0:v:0',
    '-vf',
    FEATURE_VIDEO_CHAIN,
    ...(input.hasAudio ? ['-map', '0:a:0', '-af', FEATURE_AUDIO_CHAIN] : []),
    '-threads',
    String(config.threads),
    '-f',
    'null',
    '-',
  ];
  await runToolOrThrow(
    config.ffmpegPath,
    args,
    limits(config, {
      maxFileBytes,
      cpuSeconds: config.cpuSeconds ?? config.timeoutSeconds * Math.max(1, config.threads),
    }),
    { cwd: input.scratchDir },
  );
  const read = (name: string) => readSideFile(path.join(input.scratchDir, name), maxFileBytes);
  const scene = await read(FEATURE_FILES.scene);
  if (!input.hasAudio) {
    return buildFeatures({ durationMs: input.durationMs, rms: null, silence: null, scene });
  }
  const [rms, starts, ends] = await Promise.all([
    read(FEATURE_FILES.rms),
    read(FEATURE_FILES.silenceStart),
    read(FEATURE_FILES.silenceEnd),
  ]);
  // Each file ends with a newline when FFmpeg exits cleanly, so the join keeps lines whole.
  return buildFeatures({
    durationMs: input.durationMs,
    rms,
    silence: `${starts}${ends}`,
    scene,
  });
}

// ----- Clip rendering -----------------------------------------------------------------

/**
 * Identifies the render recipe below. It is part of the render key, so bump it whenever the
 * argv or the filter chain changes in a way that alters the picture or the sound.
 */
export const CLIP_RENDERER_VERSION = 'relay-clip@1';

/** The value stored as `render_jobs.renderer_version`: the recipe plus the tool that ran it. */
export function clipRendererVersion(toolVersion: string): string {
  return `${CLIP_RENDERER_VERSION} (${toolVersion})`.slice(0, 120);
}

/** First line of `ffmpeg -version`, the encoder actually used for clips. */
export async function ffmpegVersion(config: MediaToolConfig): Promise<string> {
  const result = await runTool(
    config.ffmpegPath,
    ['-hide_banner', '-version'],
    limits(config, { timeoutMs: 10_000 }),
  );
  return result.stdout.toString('utf8').split('\n')[0]?.trim().slice(0, 120) || 'unknown';
}

/** Side files of a caption render, relative to the scratch directory. */
export const CLIP_CAPTIONS_FILE = 'captions.ass';
export const CLIP_FONTS_DIR = 'fonts';
const CLIP_FONTCONFIG_FILE = 'fonts.conf';

/**
 * Fontconfig is told about the scratch fonts directory and nothing else, so libass cannot
 * reach a system font, neither for the caption family nor as a per-glyph fallback. Both
 * paths are relative to the working directory; nothing is interpolated.
 */
const CLIP_FONTCONFIG = `<?xml version="1.0"?>
<fontconfig>
  <dir prefix="cwd">${CLIP_FONTS_DIR}</dir>
  <cachedir prefix="cwd">fontcache</cachedir>
</fontconfig>
`;

const FONT_FILE = /\.(?:otf|ttf)$/i;
const MAX_STAGED_FONTS = 64;

export type ClipRenderInputCode = 'fonts_missing' | 'captions_missing';

/** A caption render was asked for without the files it needs. Not retryable as it stands. */
export class ClipRenderInputError extends Error {
  constructor(
    readonly code: ClipRenderInputCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClipRenderInputError';
  }
}

async function fontFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && FONT_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

/**
 * Copy the caption font from the configured directory into `<scratchDir>/fonts`, where
 * `renderClip` expects it. The upright regular and bold faces of the caption family are
 * enough for the caption style; a directory that names its files differently is copied whole.
 * Throws `ClipRenderInputError('fonts_missing')` when the directory has no font files.
 */
export async function stageCaptionFonts(input: {
  fontsDir: string;
  scratchDir: string;
}): Promise<string[]> {
  const available = await fontFilesIn(input.fontsDir);
  const family = new RegExp(`^${CAPTION_FONT_FAMILY}-(?:Regular|Bold)\\.`, 'i');
  const preferred = available.filter((name) => family.test(name));
  const chosen = (preferred.length > 0 ? preferred : available).slice(0, MAX_STAGED_FONTS);
  if (chosen.length === 0) {
    throw new ClipRenderInputError(
      'fonts_missing',
      `No caption font files (.otf, .ttf) in ${input.fontsDir}; set RELAY_MEDIA_FONTS_DIR`,
    );
  }
  const target = path.join(input.scratchDir, CLIP_FONTS_DIR);
  await mkdir(target, { recursive: true });
  for (const name of chosen)
    await copyFile(path.join(input.fontsDir, name), path.join(target, name));
  return chosen;
}

/** `seconds.micros` without going through a float. */
function microsToSeconds(micros: number): string {
  return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`;
}

/** ffprobe prints times as decimal seconds with six places; read them as whole microseconds. */
function secondsToMicros(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?\d*$/.exec(value.trim());
  if (!match) return null;
  const micros = Number(match[2]) * 1_000_000 + Number((match[3] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? (match[1] === '-' ? -micros : micros) : null;
}

async function probeEntries(
  config: MediaToolConfig,
  inputPath: string,
  demuxer: string,
  extra: string[],
): Promise<{ format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> }> {
  const args = [
    '-v',
    'error',
    '-hide_banner',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    DEMUXER_WHITELIST,
    '-f',
    demuxer,
    '-select_streams',
    'v:0',
    ...extra,
    '-of',
    'json',
    '-i',
    inputPath,
  ];
  const result = await runTool(
    config.ffprobePath,
    args,
    limits(config, { timeoutMs: Math.min(config.timeoutSeconds * 1000, 120_000) }),
  );
  if (result.timedOut) throw new ToolError('ffprobe timed out', result);
  if (result.code !== 0) {
    throw new ToolError(
      `ffprobe could not read the file: ${result.stderr.trim().slice(0, 200)}`,
      result,
    );
  }
  try {
    return JSON.parse(result.stdout.toString('utf8')) as never;
  } catch {
    throw new ToolError('ffprobe returned malformed JSON', result);
  }
}

/**
 * How far the first video frame sits after the container start time, in microseconds.
 * FFmpeg's `-ss` counts from the container start, which is the earliest stream: when audio
 * leads (AAC priming, a shifted recording) the video timeline starts a little later, and a
 * clip range is defined on the video timeline.
 */
async function videoStartOffsetMicros(
  config: MediaToolConfig,
  inputPath: string,
  demuxer: string,
): Promise<number> {
  const json = await probeEntries(config, inputPath, demuxer, [
    '-show_entries',
    'format=start_time:stream=start_time',
  ]);
  const container = secondsToMicros(json.format?.start_time);
  const video = secondsToMicros(json.streams?.[0]?.start_time);
  if (container === null || video === null) return 0;
  return Math.max(0, video - container);
}

/** Half an output frame, in microseconds. */
const HALF_FRAME_MICROS = Math.round(1_000_000 / (2 * CLIP_FPS));
/** How many times the last picture may repeat when the video track ends before the range. */
const CLIP_TAIL_PAD_FRAMES = CLIP_FPS;
const CLIP_AUDIO_BITRATE = '128k';

export interface RenderClipInput {
  inputPath: string;
  demuxer: string;
  outputPath: string;
  /** Working directory of the encoder; holds `captions.ass` and `fonts/` for caption renders. */
  scratchDir: string;
  /** Range on the 0-based video timeline of the source: start inclusive, end exclusive. */
  startMs: number;
  endMs: number;
  /** From `clipGeometry`, computed on display (rotated) dimensions. */
  geometry: ClipGeometry;
  hasAudio: boolean;
  /** Burn in `<scratchDir>/captions.ass` using the fonts in `<scratchDir>/fonts`. */
  captions: boolean;
  maxOutputBytes: number;
}

function assertGeometry(g: ClipGeometry): void {
  const even = (n: number) => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0 && n <= 16384;
  const offset = (n: number) => Number.isSafeInteger(n) && n >= 0 && n % 2 === 0;
  const fill = g.scaleWidth >= g.outWidth && g.scaleHeight >= g.outHeight;
  const fit = g.scaleWidth <= g.outWidth && g.scaleHeight <= g.outHeight;
  if (
    ![g.outWidth, g.outHeight, g.scaleWidth, g.scaleHeight].every(even) ||
    ![g.cropX, g.cropY, g.padX, g.padY].every(offset) ||
    !(fill || fit) ||
    g.cropX + g.outWidth > Math.max(g.scaleWidth, g.outWidth) ||
    g.cropY + g.outHeight > Math.max(g.scaleHeight, g.outHeight) ||
    g.padX + g.scaleWidth > Math.max(g.scaleWidth, g.outWidth) ||
    g.padY + g.scaleHeight > Math.max(g.scaleHeight, g.outHeight)
  ) {
    throw new RangeError('renderClip needs a geometry from clipGeometry');
  }
}

/** The video chain. Every value is a number checked by `assertGeometry` or a constant. */
function clipVideoFilter(g: ClipGeometry, captions: boolean, halfFrameLead: boolean): string {
  const chain = [
    // The input is normally opened half a frame before the first wanted grid point (see
    // renderClip), so rounding down here is rounding to the nearest point of the source's
    // 30 fps grid. At the very start of the source there is no lead and plain rounding to
    // nearest does the same job. start_time=0 fills the first slots when the source frame
    // rate is lower than the grid.
    `fps=fps=${CLIP_FPS}:round=${halfFrameLead ? 'down' : 'near'}:start_time=0`,
    // A video track that ends slightly before the container does still yields every frame.
    `tpad=stop_mode=clone:stop=${CLIP_TAIL_PAD_FRAMES}`,
    `scale=${g.scaleWidth}:${g.scaleHeight}`,
  ];
  if (g.scaleWidth > g.outWidth || g.scaleHeight > g.outHeight) {
    chain.push(`crop=${g.outWidth}:${g.outHeight}:${g.cropX}:${g.cropY}`);
  } else if (g.scaleWidth < g.outWidth || g.scaleHeight < g.outHeight) {
    chain.push(`pad=${g.outWidth}:${g.outHeight}:${g.padX}:${g.padY}:color=black`);
  }
  chain.push('setsar=1');
  if (captions) chain.push(`subtitles=filename=${CLIP_CAPTIONS_FILE}:fontsdir=${CLIP_FONTS_DIR}`);
  chain.push('format=yuv420p');
  return chain.join(',');
}

/**
 * Render one clip: decode and re-encode `[startMs, endMs)` of the source into an H.264/AAC
 * MP4 at a constant 30 fps, scaled and cropped or padded to `geometry`, optionally with
 * burned-in captions. Never a stream copy, so the cut is frame-exact wherever the keyframes are.
 *
 * Which frames: output frame k is grid point `firstFrame + k` of the source's 30 fps
 * timeline, where `firstFrame = ceil(startMs * 30 / 1000)` and the count is `clipFrameCount`,
 * the same arithmetic the editor uses. The input is opened half a frame before the first grid
 * point, so a source frame stamped a fraction of a millisecond early (Matroska rounds to
 * whole milliseconds) is kept rather than cut, and the audio is moved by the same half frame
 * so sound and picture stay aligned.
 *
 * The output is removed on any failure, including a render that hit `maxOutputBytes`.
 */
export async function renderClip(config: MediaToolConfig, input: RenderClipInput): Promise<void> {
  const { startMs, endMs, geometry } = input;
  const frames = clipFrameCount(startMs, endMs, CLIP_FPS);
  assertGeometry(geometry);
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
    throw new RangeError('renderClip needs a positive maxOutputBytes');
  }
  const scratchDir = path.resolve(input.scratchDir);
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);

  let env: Record<string, string> | undefined;
  if (input.captions) {
    if ((await fontFilesIn(path.join(scratchDir, CLIP_FONTS_DIR))).length === 0) {
      throw new ClipRenderInputError(
        'fonts_missing',
        `Captions need the caption font in ${CLIP_FONTS_DIR}/ of the scratch directory`,
      );
    }
    const captionFile = await stat(path.join(scratchDir, CLIP_CAPTIONS_FILE)).catch(() => null);
    if (!captionFile?.isFile()) {
      throw new ClipRenderInputError(
        'captions_missing',
        `Captions need ${CLIP_CAPTIONS_FILE} in the scratch directory`,
      );
    }
    const fontconfig = path.join(scratchDir, CLIP_FONTCONFIG_FILE);
    await writeFile(fontconfig, CLIP_FONTCONFIG);
    env = { FONTCONFIG_FILE: fontconfig };
  }

  const firstFrame = Math.ceil((startMs * CLIP_FPS) / 1000);
  // Nothing to lead into at the very start of the source.
  const leadMicros = firstFrame === 0 ? 0 : HALF_FRAME_MICROS;
  const seekMicros =
    Math.round((firstFrame * 1_000_000) / CLIP_FPS) -
    leadMicros +
    (await videoStartOffsetMicros(config, inputPath, input.demuxer));

  const audioChain = [
    // Undo the half-frame lead for sound, then drop what now lies before the first picture.
    ...(leadMicros > 0 ? [`asetpts=PTS-${leadMicros}/1000000/TB`, 'atrim=start=0'] : []),
    // Fill gaps and a late start with silence so audio stays locked to the frame grid.
    'aresample=async=1:first_pts=0',
    // An audio track that ends inside or before the range is continued with silence up to
    // -t, so a source with audio always yields a clip with an audio track of the full length.
    'apad',
  ].join(',');

  const args = [
    '-filter_threads',
    '1',
    // Input options. Accurate seek (the default when re-encoding) decodes from the previous
    // keyframe and discards everything before the target. Decoder threads are capped like
    // the encoder's: left alone they follow the core count, and so does the address space.
    ...(seekMicros > 0 ? ['-ss', microsToSeconds(seekMicros)] : []),
    '-threads',
    String(config.threads),
    ...COMMON_INPUT(input.demuxer, inputPath),
    '-map',
    '0:v:0',
    ...(input.hasAudio ? ['-map', '0:a:0'] : ['-an']),
    // Source tags (location, device, titles) do not belong in a derived clip.
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-t',
    ((endMs - startMs) / 1000).toFixed(3),
    // -t alone can admit one frame more than the grid holds; this is the exact count.
    '-frames:v',
    String(frames),
    '-vf',
    clipVideoFilter(geometry, input.captions, leadMicros > 0),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-maxrate',
    '8M',
    '-bufsize',
    '16M',
    '-g',
    String(CLIP_FPS * 2),
    '-pix_fmt',
    'yuv420p',
    // The preset's own lookahead and reference count, pinned so memory does not move with a
    // library update. Measured at 1080x1920 with two threads: about 280 MB resident and
    // 1.0 GB of address space. Turning lookahead off saves 75 MB but costs about 45% more
    // bits at the same CRF, so it stays on.
    '-x264-params',
    'rc-lookahead=10:ref=1',
    ...(input.hasAudio
      ? ['-af', audioChain, '-c:a', 'aac', '-b:a', CLIP_AUDIO_BITRATE, '-ac', '2', '-ar', '48000']
      : []),
    '-movflags',
    '+faststart',
    '-threads',
    String(config.threads),
    '-fs',
    String(input.maxOutputBytes),
    '-f',
    'mp4',
    '-y',
    outputPath,
  ];

  try {
    const result = await runToolOrThrow(
      config.ffmpegPath,
      args,
      limits(config, {
        maxFileBytes: input.maxOutputBytes + 1024 * 1024,
        cpuSeconds: config.cpuSeconds ?? config.timeoutSeconds * Math.max(1, config.threads),
      }),
      { cwd: scratchDir, ...(env ? { env } : {}) },
    );
    // -fs makes FFmpeg stop writing and exit 0, which would leave a short but playable file.
    const { size } = await stat(outputPath);
    if (size >= input.maxOutputBytes) {
      throw new ToolError(
        `The rendered clip reached the ${input.maxOutputBytes} byte output limit`,
        result,
      );
    }
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

export interface ClipOutputExpectation {
  width: number;
  height: number;
  /** `clipFrameCount(startMs, endMs)`. */
  frameCount: number;
  /** Whether the source had audio; the clip has an AAC track exactly then. */
  hasAudio: boolean;
}

/** A rendered clip is not what was asked for. Permanent: a retry would render the same file. */
export class ClipVerificationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Rendered clip failed verification: ${problems.join('; ')}`);
    this.name = 'ClipVerificationError';
  }
}

/**
 * Check a rendered clip against the request before it is published as an asset: container
 * layout, codecs, pixel format, exact size, exact frame count and audio presence. Returns the
 * probe of the output; throws `ClipVerificationError` listing every mismatch.
 */
export async function verifyClipOutput(
  config: MediaToolConfig,
  outputPath: string,
  expected: ClipOutputExpectation,
): Promise<ProbeSummary> {
  const problems: string[] = [];
  if (!(await isFastStartMp4(outputPath))) problems.push('moov does not precede mdat');

  const probe = await probeFile(config, outputPath, 'mov');
  if (probe.encrypted) problems.push('output is marked encrypted');
  const video = probe.streams.filter((s) => s.type === 'video');
  const audio = probe.streams.filter((s) => s.type === 'audio');
  const other = probe.streams.filter((s) => s.type !== 'video' && s.type !== 'audio');
  if (other.length > 0) problems.push(`unexpected ${other.map((s) => s.type).join(', ')} stream`);

  const v = video[0];
  if (!v || video.length !== 1) {
    problems.push(`expected one video stream, found ${video.length}`);
  } else {
    if (v.codec !== 'h264') problems.push(`video codec is ${v.codec ?? 'unknown'}, not h264`);
    if (v.pixFmt !== 'yuv420p') problems.push(`pixel format is ${v.pixFmt ?? 'unknown'}`);
    if (v.width !== expected.width || v.height !== expected.height) {
      problems.push(
        `size is ${v.width ?? '?'}x${v.height ?? '?'}, expected ${expected.width}x${expected.height}`,
      );
    }
    if (v.rotation !== 0) problems.push(`output carries a ${v.rotation} degree rotation`);
    if (v.avgFrameRate !== CLIP_FPS) {
      problems.push(`frame rate is ${v.avgFrameRate ?? 'unknown'}, expected ${CLIP_FPS}`);
    }
    // The count in the index and the packets actually present must both match: a truncated
    // file can keep a correct-looking index.
    const counted = await probeEntries(config, outputPath, 'mov', [
      '-count_packets',
      '-show_entries',
      'stream=nb_frames,nb_read_packets',
    ]);
    const indexed = num(counted.streams?.[0]?.nb_frames);
    const packets = num(counted.streams?.[0]?.nb_read_packets);
    if (indexed !== expected.frameCount || packets !== expected.frameCount) {
      problems.push(
        `frame count is ${indexed ?? '?'} (index) / ${packets ?? '?'} (packets), expected ${expected.frameCount}`,
      );
    }
  }

  if (expected.hasAudio) {
    if (audio.length !== 1) problems.push(`expected one audio stream, found ${audio.length}`);
    else if (audio[0]?.codec !== 'aac') problems.push(`audio codec is ${audio[0]?.codec}, not aac`);
  } else if (audio.length > 0) {
    problems.push('output has audio but the source had none');
  }

  if (problems.length > 0) throw new ClipVerificationError(problems);
  return probe;
}
