import type { ProbeStream, ProbeSummary } from '@relay/domain';
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
}

/** Demuxers permitted for uploads. */
export const DEMUXER_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,jpeg_pipe,png_pipe,webp_pipe,image2';

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
  const root = (json ?? {}) as { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  const format = root.format ?? {};
  let encrypted = false;
  const streams: ProbeStream[] = (root.streams ?? []).map((s) => {
    const type = (['video', 'audio', 'subtitle', 'data', 'attachment'] as const).find((t) => t === s.codec_type) ?? 'unknown';
    const tag = typeof s.codec_tag_string === 'string' ? s.codec_tag_string : null;
    if (tag && ENCRYPTED_TAGS.has(tag)) encrypted = true;
    const sideData = Array.isArray(s.side_data_list) ? (s.side_data_list as Array<Record<string, unknown>>) : [];
    if (sideData.some((d) => typeof d.side_data_type === 'string' && /encryption/i.test(d.side_data_type))) encrypted = true;
    const displayMatrix = sideData.find((d) => typeof d.rotation === 'number' || typeof d.rotation === 'string');
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
  const result = await runTool(config.ffprobePath, ['-hide_banner', '-version'], limits(config, { timeoutMs: 10_000 }));
  return result.stdout.toString('utf8').split('\n')[0]?.trim().slice(0, 120) ?? 'unknown';
}

export async function probeFile(config: MediaToolConfig, inputPath: string, demuxer: string): Promise<ProbeSummary> {
  const args = [
    '-v', 'error',
    '-hide_banner',
    '-protocol_whitelist', PROTOCOL_WHITELIST,
    '-format_whitelist', DEMUXER_WHITELIST,
    '-f', demuxer,
    '-show_format',
    '-show_streams',
    '-of', 'json',
    '-i', inputPath,
  ];
  const result = await runTool(config.ffprobePath, args, limits(config, { timeoutMs: Math.min(config.timeoutSeconds * 1000, 120_000) }));
  if (result.timedOut) throw new ToolError('ffprobe timed out', result);
  if (result.code !== 0) throw new ToolError(`ffprobe could not read the file: ${result.stderr.trim().slice(0, 200)}`, result);
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
async function firstPacketsEncrypted(config: MediaToolConfig, inputPath: string, demuxer: string): Promise<boolean> {
  const args = [
    '-v', 'quiet',
    '-hide_banner',
    '-protocol_whitelist', PROTOCOL_WHITELIST,
    '-format_whitelist', DEMUXER_WHITELIST,
    '-f', demuxer,
    '-read_intervals', '%+#3',
    '-show_packets',
    '-show_entries', 'packet=stream_index:packet_side_data=side_data_type',
    '-of', 'json',
    '-i', inputPath,
  ];
  const result = await runTool(config.ffprobePath, args, limits(config, { timeoutMs: 30_000 }));
  if (result.code !== 0 || result.timedOut) return false;
  try {
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      packets?: Array<{ side_data_list?: Array<{ side_data_type?: string }> }>;
    };
    return (parsed.packets ?? []).some((p) =>
      (p.side_data_list ?? []).some((d) => typeof d.side_data_type === 'string' && /encryption/i.test(d.side_data_type)),
    );
  } catch {
    return false;
  }
}

const COMMON_INPUT = (demuxer: string, inputPath: string) => [
  '-nostdin',
  '-hide_banner',
  '-loglevel', 'error',
  '-protocol_whitelist', PROTOCOL_WHITELIST,
  '-format_whitelist', DEMUXER_WHITELIST,
  '-f', demuxer,
  '-i', inputPath,
];

/** JPEG poster/thumbnail, longest side ≤ maxSide, display orientation applied. */
export async function renderThumbnail(
  config: MediaToolConfig,
  input: { path: string; demuxer: string; kind: 'video' | 'image'; durationMs: number | null; outputPath: string; maxSide: number },
): Promise<void> {
  const seekSeconds = input.kind === 'video' && input.durationMs ? Math.min(1, input.durationMs / 2000) : 0;
  const scale = `scale=w='min(${input.maxSide},iw)':h='min(${input.maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const args = [
    ...(seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : []),
    ...COMMON_INPUT(input.demuxer, input.path),
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', scale,
    '-q:v', '4',
    '-threads', String(config.threads),
    '-f', 'image2',
    '-c:v', 'mjpeg',
    '-y', input.outputPath,
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
  input: { path: string; demuxer: string; outputPath: string; maxSide: number; maxOutputBytes: number },
): Promise<void> {
  const scale = `scale=w='min(${input.maxSide},iw)':h='min(${input.maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const args = [
    ...COMMON_INPUT(input.demuxer, input.path),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `${scale},fps=30`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-movflags', '+faststart',
    '-threads', String(config.threads),
    '-fs', String(input.maxOutputBytes),
    '-f', 'mp4',
    '-y', input.outputPath,
  ];
  await runToolOrThrow(config.ffmpegPath, args, limits(config, { maxFileBytes: input.maxOutputBytes + 1024 * 1024 }));
}
