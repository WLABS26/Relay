import { open } from 'node:fs/promises';
import path from 'node:path';
import type { ProbeStream, ProbeSummary } from '@relay/domain';
import { buildFeatures, RMS_HOP_MS, type MediaFeatures } from './analysis';
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
