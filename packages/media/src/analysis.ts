/**
 * Pure parsers for the side files FFmpeg writes during feature extraction (`extractFeatures`
 * in `ffmpeg.ts`). The files come from `metadata=mode=print` / `ametadata=mode=print`, which
 * emit a header line per frame followed by `key=value` lines:
 *
 *   frame:12   pts:9600    pts_time:1.2
 *   lavfi.astats.Overall.RMS_level=-29.118420
 *
 * The content is derived from an uploaded file, so nothing here trusts it: every parser is
 * line-based, skips what it does not recognise, bounds how much it keeps and never throws.
 */

/** Version of the extraction graph and these parsers; stored with every analysis. */
export const ANALYZER_VERSION = 'relay-analyze@1';

/** Spacing of the RMS envelope. The extraction graph cuts audio into frames of this length. */
export const RMS_HOP_MS = 100;

/** Level stored for digital silence (`-inf`), `nan` and gaps, so the envelope stays finite. */
export const RMS_FLOOR_DB = -100;

/** Float audio can exceed full scale; anything far above it is a decoder artefact. */
const RMS_CEILING_DB = 20;

/** Six hours of envelope at the 100 ms hop: the largest source the media timeout allows. */
export const MAX_RMS_POINTS = 216_000;
export const MAX_SILENCES = 10_000;
export const MAX_SCENE_CHANGES = 10_000;

export interface SilenceRange {
  /** Inclusive, milliseconds on the 0-based media timeline. */
  startMs: number;
  /** Exclusive. */
  endMs: number;
}

/**
 * Input of the highlight ranker (`rankHighlights` in `@relay/domain`). Declared here as well
 * so the media package does not depend on the ranker's module; the shapes are structurally
 * identical.
 */
export interface MediaFeatures {
  durationMs: number;
  /** RMS level in dBFS per 100 ms hop, or null when the source has no audio. */
  rmsDb: number[] | null;
  silences: SilenceRange[];
  sceneChangesMs: number[];
}

const RMS_KEY = 'lavfi.astats.Overall.RMS_level';
const SILENCE_START_KEY = 'lavfi.silence_start';
const SILENCE_END_KEY = 'lavfi.silence_end';
const SCENE_KEY = 'lavfi.scd.time';

type Entry =
  { type: 'frame'; ptsMs: number | null } | { type: 'value'; key: string; value: string };

/**
 * Complete lines only. FFmpeg can be killed mid-write (timeout, file-size limit), and a cut
 * line such as `...RMS_level=-2` would otherwise read as a valid, very loud sample.
 */
function completeLines(text: string): string[] {
  const end = text.lastIndexOf('\n');
  if (end < 0) return [];
  return text.slice(0, end).split('\n');
}

/** A plain decimal, or null. Rejects hex, exponents and empty strings that Number() accepts. */
function decimal(raw: string): number | null {
  const value = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function secondsToMs(raw: string): number | null {
  const seconds = decimal(raw);
  return seconds === null ? null : Math.round(seconds * 1000);
}

function* entries(text: string): Generator<Entry> {
  for (const rawLine of completeLines(text)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('frame:')) {
      const match = /\bpts_time:(\S+)/.exec(line);
      yield { type: 'frame', ptsMs: match?.[1] ? secondsToMs(match[1]) : null };
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) yield { type: 'value', key: line.slice(0, eq), value: line.slice(eq + 1) };
  }
}

function clampMs(ms: number, durationMs: number): number {
  return Math.min(Math.max(ms, 0), Math.max(durationMs, 0));
}

/**
 * RMS envelope in dBFS, one value per 100 ms. Samples are placed by their frame timestamp
 * rather than by line order, so a dropped or duplicated line cannot shift everything after
 * it; hops without a sample (and `-inf` / `nan`) hold the floor. The result never extends
 * past `durationMs` or `maxPoints`. An input without a single usable sample gives `[]`.
 */
export function parseRmsFile(
  text: string,
  options: { durationMs: number; maxPoints?: number },
): number[] {
  const limit = Math.max(
    0,
    Math.min(
      options.maxPoints ?? MAX_RMS_POINTS,
      MAX_RMS_POINTS,
      Math.ceil(options.durationMs / RMS_HOP_MS),
    ),
  );
  const samples = new Map<number, number>();
  let last = -1;
  let ptsMs: number | null = null;
  for (const entry of entries(text)) {
    if (entry.type === 'frame') {
      ptsMs = entry.ptsMs;
      continue;
    }
    if (entry.key !== RMS_KEY || ptsMs === null) continue;
    const index = Math.round(ptsMs / RMS_HOP_MS);
    if (index < 0 || index >= limit) continue;
    const value = entry.value.trim().toLowerCase();
    let db: number | null;
    if (value === '-inf' || value === 'nan' || value === '-nan') db = RMS_FLOOR_DB;
    else if (value === 'inf' || value === '+inf') db = RMS_CEILING_DB;
    else db = decimal(value);
    if (db === null) continue;
    samples.set(index, Math.min(Math.max(db, RMS_FLOOR_DB), RMS_CEILING_DB));
    if (index > last) last = index;
  }
  const envelope = new Array<number>(last + 1).fill(RMS_FLOOR_DB);
  for (const [index, db] of samples) envelope[index] = db;
  return envelope;
}

/**
 * Silent ranges from `lavfi.silence_start` / `lavfi.silence_end` lines, in any order (the
 * extraction graph prints the two keys to separate files and the caller concatenates them).
 * A start without a later end is a silence that runs to the end of the source, which
 * `silencedetect` reports only in its log; it is closed at `durationMs`. An end without a
 * start is dropped. Ranges are clamped to the source, sorted, and merged where they touch.
 */
export function parseSilenceFile(text: string, options: { durationMs: number }): SilenceRange[] {
  const marks: Array<{ ms: number; start: boolean }> = [];
  // Starts and ends are capped separately. The caller passes every start before any end, so a
  // shared cap would keep only starts and report one silence covering the rest of the source.
  let starts = 0;
  let ends = 0;
  for (const entry of entries(text)) {
    if (entry.type !== 'value') continue;
    const start = entry.key === SILENCE_START_KEY;
    if (!start && entry.key !== SILENCE_END_KEY) continue;
    const ms = secondsToMs(entry.value);
    if (ms === null) continue;
    if (start ? starts >= MAX_SILENCES : ends >= MAX_SILENCES) continue;
    if (start) starts += 1;
    else ends += 1;
    // A silence that opens with the first sample can carry a slightly negative time; clamp.
    marks.push({ ms: clampMs(ms, options.durationMs), start });
  }
  // Past the cap the kept starts and ends may not pair up; a start left open there must not
  // run to the end of the source.
  const capped = starts >= MAX_SILENCES || ends >= MAX_SILENCES;
  // At equal times an end sorts first, so back-to-back silences close before the next opens.
  marks.sort((a, b) => a.ms - b.ms || Number(a.start) - Number(b.start));

  const ranges: SilenceRange[] = [];
  let open: number | null = null;
  const close = (endMs: number) => {
    if (open === null || endMs <= open) return;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.endMs >= open) previous.endMs = Math.max(previous.endMs, endMs);
    else ranges.push({ startMs: open, endMs });
  };
  for (const mark of marks) {
    if (mark.start) {
      // Two starts in a row mean the end between them was lost; keep the earlier one.
      if (open === null) open = mark.ms;
    } else {
      close(mark.ms);
      open = null;
    }
  }
  if (!capped) close(clampMs(options.durationMs, options.durationMs));
  return ranges.slice(0, MAX_SILENCES);
}

/** Scene-change times in milliseconds: ascending, unique, inside `[0, durationMs)`. */
export function parseSceneFile(text: string, options: { durationMs: number }): number[] {
  const times = new Set<number>();
  for (const entry of entries(text)) {
    if (entry.type !== 'value' || entry.key !== SCENE_KEY) continue;
    const ms = secondsToMs(entry.value);
    // A "change" at the very first frame is the start of the source, not a cut.
    if (ms === null || ms <= 0 || ms >= options.durationMs) continue;
    times.add(ms);
    if (times.size >= MAX_SCENE_CHANGES) break;
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Assemble the ranker input from the raw side files. `rms` and `silence` are null when the
 * source has no audio stream, which is different from audio that is entirely silent.
 */
export function buildFeatures(input: {
  durationMs: number;
  rms: string | null;
  silence: string | null;
  scene: string;
}): MediaFeatures {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  return {
    durationMs,
    rmsDb: input.rms === null ? null : parseRmsFile(input.rms, { durationMs }),
    silences: input.silence === null ? [] : parseSilenceFile(input.silence, { durationMs }),
    sceneChangesMs: parseSceneFile(input.scene, { durationMs }),
  };
}
