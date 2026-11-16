/**
 * Deterministic highlight ranker (algorithm "relay-ranker@1").
 *
 * A pure function over pre-extracted feature windows: no clock, no randomness, no I/O. The same
 * features and options always give the same candidates, so a stored analysis can be reproduced
 * from its `ranker_version` alone. It finds loud or busy moments, not necessarily good ones:
 * every candidate is a suggestion and carries the numbers that produced it.
 */

export const RANKER_VERSION = 'relay-ranker@1';

/** Hop between `rmsDb` samples; the analyzer emits one RMS value per 100 ms of audio. */
export const RMS_HOP_MS = 100;

/**
 * The v1 mapping of the spec's "source cues" to weights. Renormalised over the signals that are
 * actually present, so a source without audio is ranked on scene changes alone.
 */
export const RANKER_WEIGHTS = { energy: 0.45, onset: 0.3, scene: 0.25 } as const;

export interface FeatureSilence {
  startMs: number;
  endMs: number;
}

export interface HighlightFeatures {
  durationMs: number;
  /** RMS level in dBFS per 100 ms hop, or null when the source has no audio. */
  rmsDb: readonly number[] | null;
  silences: readonly FeatureSilence[];
  sceneChangesMs: readonly number[];
}

export interface RankOptions {
  windowMs: number;
  strideMs: number;
  minMs: number;
  maxMs: number;
  maxCandidates: number;
  iou: number;
}

export const DEFAULT_RANK_OPTIONS: RankOptions = {
  windowMs: 5000,
  strideMs: 2500,
  minMs: 15000,
  maxMs: 60000,
  maxCandidates: 10,
  iou: 0.5,
};

export type HighlightSignal = 'audio' | 'scene';

/** How a candidate edge was chosen; only `silence` edges are described as pauses to the user. */
export type RangeSnap =
  'silence' | 'padded' | 'min_length' | 'max_length' | 'source_start' | 'source_end';

export interface HighlightEvidence {
  signals: HighlightSignal[];
  wholeSource: boolean;
  peakMs: number | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  /** Loudest 100 ms in the peak window, in dBFS; null without audio. */
  peakDb: number | null;
  /** Loudest 100 ms in the peak window relative to the source's median level. */
  levelRatio: number | null;
  sceneChanges: number;
  /** Per-feature scores (0..1) of the peak window before weighting. */
  features: { energy: number | null; onset: number | null; scene: number | null };
  startSnap: RangeSnap;
  endSnap: RangeSnap;
  coverage: number;
}

export interface HighlightCandidate {
  rank: number;
  startMs: number;
  endMs: number;
  score: number;
  confidence: number;
  coverage: number;
  reason: string;
  evidence: HighlightEvidence;
}

export interface RankSummary {
  /** Neither audio nor a scene change: nothing to rank, the UI offers a manual range. */
  noSignal: boolean;
  signals: HighlightSignal[];
  hasAudio: boolean;
  sceneChangeCount: number;
  windowCount: number;
  peakCount: number;
  candidateCount: number;
  coverage: number;
}

export interface RankResult {
  rankerVersion: string;
  candidates: HighlightCandidate[];
  summary: RankSummary;
}

/** Peaks below this combined score are noise around the median, not highlights. */
const MIN_PEAK_SCORE = 0.25;
/** A robust z of 4 saturates a feature; beyond that "louder" adds nothing to the ranking. */
const Z_CLAMP = 4;
const MAD_TO_SIGMA = 1.4826;
/** Smoothing span for onset detection: 500 ms = 5 hops. */
const ONSET_SMOOTH_HOPS = 5;
/**
 * Scale floors keep a perfectly flat feature (MAD = 0) from turning rounding noise into a
 * saturated z. They are relative to the source's typical level so the ranking does not depend
 * on how loud the recording is: energy saturates at about twice the typical level, an onset
 * must jump by several times the typical level, and one scene cut is half a saturation.
 */
const ENERGY_FLOOR_RATIO = 0.25;
const ONSET_FLOOR_RATIO = 1;
const SCENE_FLOOR = 0.5;
/** -80 dBFS: below this a "typical level" is digital silence and ratios are meaningless. */
const MIN_TYPICAL_LINEAR = 1e-4;
const MIN_DB = -120;
const MAX_DB = 20;
const SILENCE_LOOKBACK_MS = 8000;
const PAD_MS = 3000;
const SIGNAL_COUNT = 3;

interface Window {
  startMs: number;
  endMs: number;
  energy: number;
  onset: number;
  scene: number;
  completeness: number;
  loudestMs: number | null;
  loudestLinear: number;
  firstSceneMs: number | null;
  parts: { energy: number; onset: number; scene: number };
  score: number;
}

interface Cluster {
  main: Window;
  mainAnchorMs: number;
  firstAnchorMs: number;
  firstWindowStartMs: number;
  lastAnchorMs: number;
  lastWindowEndMs: number;
}

interface Range {
  startMs: number;
  endMs: number;
  startSnap: RangeSnap;
  endSnap: RangeSnap;
}

export function rankHighlights(
  features: HighlightFeatures,
  options: Partial<RankOptions> = {},
): RankResult {
  const opts = resolveOptions(options);
  const durationMs = Number.isFinite(features.durationMs)
    ? Math.max(0, Math.floor(features.durationMs))
    : 0;

  const scenes = cleanScenes(features.sceneChangesMs, durationMs);
  const silences = cleanSilences(features.silences, durationMs);
  const audio = prepareAudio(features.rmsDb, durationMs);

  const signals: HighlightSignal[] = [];
  if (audio) signals.push('audio');
  if (scenes.length > 0) signals.push('scene');
  // Audio carries two of the three signals (energy and onset); scene changes are the third.
  const signalShare = ((audio ? 2 : 0) + (scenes.length > 0 ? 1 : 0)) / SIGNAL_COUNT;

  const summary: RankSummary = {
    noSignal: signals.length === 0,
    signals,
    hasAudio: audio !== null,
    sceneChangeCount: scenes.length,
    windowCount: 0,
    peakCount: 0,
    candidateCount: 0,
    coverage: round(signalShare * (audio ? audio.completeness : 1), 3),
  };
  if (durationMs === 0 || signals.length === 0) {
    return { rankerVersion: RANKER_VERSION, candidates: [], summary };
  }

  const windows = buildWindows(durationMs, opts, audio, scenes);
  scoreWindows(windows, audio, scenes.length > 0);
  summary.windowCount = windows.length;

  const describe = (w: Window | null, range: Range): HighlightCandidate => {
    const coverage = round(signalShare * (audio && w ? w.completeness : audio ? 0 : 1), 3);
    const score = round(w ? w.score : 0, 4);
    const sceneChanges = countInRange(scenes, range.startMs, range.endMs);
    const audioDriven = audio !== null && w !== null && w.parts.energy + w.parts.onset > 0;
    const peakMs = w ? anchorOf(w, audio !== null) : null;
    const levelRatio =
      audio && w && w.loudestMs !== null
        ? round(w.loudestLinear / Math.max(audio.typical, MIN_TYPICAL_LINEAR), 2)
        : null;
    const wholeSource = durationMs < opts.minMs;
    const evidence: HighlightEvidence = {
      signals: [...signals],
      wholeSource,
      peakMs,
      windowStartMs: w ? w.startMs : null,
      windowEndMs: w ? w.endMs : null,
      peakDb:
        audio && w && w.loudestMs !== null && w.loudestLinear > 0
          ? round(20 * Math.log10(w.loudestLinear), 1)
          : null,
      levelRatio,
      sceneChanges,
      features: {
        energy: audio && w ? round(w.parts.energy, 3) : null,
        onset: audio && w ? round(w.parts.onset, 3) : null,
        scene: scenes.length > 0 && w ? round(w.parts.scene, 3) : null,
      },
      startSnap: range.startSnap,
      endSnap: range.endSnap,
      coverage,
    };
    return {
      rank: 0,
      startMs: range.startMs,
      endMs: range.endMs,
      score,
      // Confidence is never higher than the evidence behind it: a scene-only window can score
      // 1.0 and still be only a third as certain as one backed by all three signals.
      // Rounding to three places must not lift it above the four-place score either.
      confidence: Math.min(score, round(score * coverage, 3)),
      coverage,
      reason: buildReason({
        wholeSource,
        minMs: opts.minMs,
        audioDriven,
        peakMs,
        levelRatio,
        sceneChanges,
        range,
        hasAudio: audio !== null,
      }),
      evidence,
    };
  };

  // A source shorter than the minimum clip cannot be trimmed further: suggest all of it.
  if (durationMs < opts.minMs) {
    const best = windows.reduce<Window | null>((a, w) => (a && a.score >= w.score ? a : w), null);
    const whole = describe(best, {
      startMs: 0,
      endMs: durationMs,
      startSnap: 'source_start',
      endSnap: 'source_end',
    });
    whole.rank = 1;
    summary.candidateCount = 1;
    return { rankerVersion: RANKER_VERSION, candidates: [whole], summary };
  }

  const peaks = findPeaks(windows);
  summary.peakCount = peaks.length;

  const clusters = clusterPeaks(peaks, audio !== null, opts.minMs);
  const kept: HighlightCandidate[] = [];
  // Clusters are already in score order, so every kept candidate outranks the one being tested.
  for (const cluster of clusters) {
    if (kept.length >= opts.maxCandidates) break;
    const range = rangeFor(cluster, silences, durationMs, opts);
    if (kept.some((k) => iou(k, range) > opts.iou)) continue;
    kept.push(describe(cluster.main, range));
  }

  kept.sort((a, b) => b.score - a.score || a.startMs - b.startMs || a.endMs - b.endMs);
  kept.forEach((c, i) => {
    c.rank = i + 1;
  });
  summary.candidateCount = kept.length;
  return { rankerVersion: RANKER_VERSION, candidates: kept, summary };
}

export interface Envelope {
  /** Milliseconds covered by each point. */
  hopMs: number;
  /** Loudest RMS level in dBFS per bucket, one decimal. */
  points: number[];
}

/**
 * Reduce the 100 ms RMS series to at most `maxPoints` for the editor waveform. Each bucket keeps
 * its loudest sample so short peaks stay visible however long the source is.
 */
export function downsampleEnvelope(
  rmsDb: readonly number[] | null,
  maxPoints = 2000,
): Envelope | null {
  if (!rmsDb || rmsDb.length === 0) return null;
  if (!Number.isInteger(maxPoints) || maxPoints < 1) {
    throw new RangeError('maxPoints must be a positive integer');
  }
  const bucket = Math.ceil(rmsDb.length / maxPoints);
  const points: number[] = [];
  for (let i = 0; i < rmsDb.length; i += bucket) {
    let max = MIN_DB;
    for (let j = i; j < Math.min(i + bucket, rmsDb.length); j++) {
      const db = rmsDb[j] ?? Number.NaN;
      // NaN and -inf (digital silence) both draw as the floor.
      if (Number.isFinite(db) && db > max) max = Math.min(db, MAX_DB);
    }
    points.push(round(max, 1));
  }
  return { hopMs: RMS_HOP_MS * bucket, points };
}

function resolveOptions(options: Partial<RankOptions>): RankOptions {
  const opts = { ...DEFAULT_RANK_OPTIONS, ...options };
  const positiveInt = (n: number) => Number.isInteger(n) && n > 0;
  if (!positiveInt(opts.windowMs) || !positiveInt(opts.strideMs)) {
    throw new RangeError('windowMs and strideMs must be positive integers');
  }
  if (!positiveInt(opts.minMs) || !positiveInt(opts.maxMs) || opts.maxMs < opts.minMs) {
    throw new RangeError('minMs and maxMs must be positive integers with minMs <= maxMs');
  }
  if (!Number.isInteger(opts.maxCandidates) || opts.maxCandidates < 0) {
    throw new RangeError('maxCandidates must be a non-negative integer');
  }
  if (!(opts.iou >= 0 && opts.iou <= 1)) {
    throw new RangeError('iou must be between 0 and 1');
  }
  return opts;
}

function cleanScenes(sceneChangesMs: readonly number[], durationMs: number): number[] {
  // Round first: a cut in the last half millisecond would otherwise round onto `durationMs`,
  // which is outside the half-open source range and belongs to no window.
  const inRange = sceneChangesMs
    .filter((t) => Number.isFinite(t))
    .map((t) => Math.round(t))
    .filter((t) => t >= 0 && t < durationMs);
  return [...new Set(inRange)].sort((a, b) => a - b);
}

function cleanSilences(silences: readonly FeatureSilence[], durationMs: number): FeatureSilence[] {
  return silences
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs))
    .map((s) => ({
      startMs: Math.max(0, Math.round(s.startMs)),
      endMs: Math.min(durationMs, Math.round(s.endMs)),
    }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

interface Audio {
  /** Linear amplitude per hop; null where the analyzer produced no usable sample. */
  linear: (number | null)[];
  /** Largest rise of the smoothed envelope over the preceding 500 ms, per hop. */
  onset: number[];
  /** Median linear level of the whole source: the "typical level" in reasons. */
  typical: number;
  completeness: number;
}

function prepareAudio(rmsDb: readonly number[] | null, durationMs: number): Audio | null {
  if (!rmsDb) return null;
  const expected = Math.ceil(durationMs / RMS_HOP_MS);
  const linear: (number | null)[] = [];
  const present: number[] = [];
  for (let i = 0; i < Math.min(rmsDb.length, expected); i++) {
    const value = toLinear(rmsDb[i] ?? Number.NaN);
    linear.push(value);
    if (value !== null) present.push(value);
  }
  if (present.length === 0) return null;

  // Average only the usable samples in each 500 ms span and hold the last level across a gap:
  // a missing sample is unknown, not silence, and must not read as a drop followed by an onset.
  const smoothed: number[] = [];
  let last = present[0] ?? 0;
  for (let i = 0; i < linear.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - ONSET_SMOOTH_HOPS + 1); j <= i; j++) {
      const value = linear[j] ?? null;
      if (value === null) continue;
      sum += value;
      count++;
    }
    if (count > 0) last = sum / count;
    smoothed.push(last);
  }
  const onset = smoothed.map((v, i) =>
    Math.max(0, v - (smoothed[Math.max(0, i - ONSET_SMOOTH_HOPS)] ?? v)),
  );
  return {
    linear,
    onset,
    typical: median(present),
    completeness: expected > 0 ? present.length / expected : 0,
  };
}

function toLinear(db: number): number | null {
  if (db === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(db)) return null;
  return 10 ** (Math.min(MAX_DB, Math.max(MIN_DB, db)) / 20);
}

function buildWindows(
  durationMs: number,
  opts: RankOptions,
  audio: Audio | null,
  scenes: readonly number[],
): Window[] {
  const windows: Window[] = [];
  for (let startMs = 0; startMs < durationMs; startMs += opts.strideMs) {
    const endMs = Math.min(startMs + opts.windowMs, durationMs);
    // A short tail window would compare a fraction of a window against whole ones; the
    // previous window already covers that stretch. The first window is always kept.
    if (startMs > 0 && endMs - startMs < opts.windowMs / 2) break;

    const w: Window = {
      startMs,
      endMs,
      energy: 0,
      onset: 0,
      scene: 0,
      completeness: audio ? 0 : 1,
      loudestMs: null,
      loudestLinear: 0,
      firstSceneMs: null,
      parts: { energy: 0, onset: 0, scene: 0 },
      score: 0,
    };
    if (audio) {
      const from = Math.floor(startMs / RMS_HOP_MS);
      const to = Math.ceil(endMs / RMS_HOP_MS);
      let sum = 0;
      let count = 0;
      for (let i = from; i < Math.min(to, audio.linear.length); i++) {
        const value = audio.linear[i] ?? null;
        if (value === null) continue;
        sum += value;
        count++;
        w.onset = Math.max(w.onset, audio.onset[i] ?? 0);
        if (w.loudestMs === null || value > w.loudestLinear) {
          w.loudestLinear = value;
          w.loudestMs = i * RMS_HOP_MS;
        }
      }
      w.energy = count > 0 ? sum / count : 0;
      w.completeness = to > from ? count / (to - from) : 0;
    }
    for (const t of scenes) {
      if (t >= endMs) break;
      if (t < startMs) continue;
      w.scene++;
      w.firstSceneMs ??= t;
    }
    windows.push(w);
  }
  return windows;
}

function scoreWindows(windows: Window[], audio: Audio | null, hasScenes: boolean): void {
  const typical = audio ? Math.max(audio.typical, MIN_TYPICAL_LINEAR) : 0;
  const energy = robust(
    windows.map((w) => w.energy),
    ENERGY_FLOOR_RATIO * typical,
  );
  const onset = robust(
    windows.map((w) => w.onset),
    ONSET_FLOOR_RATIO * typical,
  );
  const scene = robust(
    windows.map((w) => w.scene),
    SCENE_FLOOR,
  );
  const total =
    (audio ? RANKER_WEIGHTS.energy + RANKER_WEIGHTS.onset : 0) +
    (hasScenes ? RANKER_WEIGHTS.scene : 0);
  for (const w of windows) {
    w.parts = {
      energy: audio ? energy(w.energy) : 0,
      onset: audio ? onset(w.onset) : 0,
      scene: hasScenes ? scene(w.scene) : 0,
    };
    w.score =
      total > 0
        ? (RANKER_WEIGHTS.energy * w.parts.energy +
            RANKER_WEIGHTS.onset * w.parts.onset +
            RANKER_WEIGHTS.scene * w.parts.scene) /
          total
        : 0;
  }
}

/** Robust z against the median, clamped to 0..4 and scaled to 0..1. */
function robust(values: readonly number[], floor: number): (x: number) => number {
  const mid = median(values);
  const mad = median(values.map((v) => Math.abs(v - mid)));
  const scale = MAD_TO_SIGMA * mad + floor;
  return (x) => Math.min(Z_CLAMP, Math.max(0, (x - mid) / scale)) / Z_CLAMP;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

/** Local maxima above the minimum score, best first. A plateau counts once, at its start. */
function findPeaks(windows: readonly Window[]): Window[] {
  const peaks = windows.filter((w, i) => {
    const before = windows[i - 1]?.score ?? -1;
    const after = windows[i + 1]?.score ?? -1;
    return w.score >= MIN_PEAK_SCORE && w.score > before && w.score >= after;
  });
  return peaks.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
}

/** The instant a window's highlight is pinned to: its loudest hop, or its first cut. */
function anchorOf(w: Window, hasAudio: boolean): number {
  if (hasAudio && w.parts.energy + w.parts.onset > 0 && w.loudestMs !== null) return w.loudestMs;
  return w.firstSceneMs ?? w.loudestMs ?? w.startMs;
}

/**
 * Peaks closer together than the minimum clip length cannot be separate clips, so the weaker
 * one is folded into the stronger and only widens the stretch its clip has to cover.
 */
function clusterPeaks(peaks: readonly Window[], hasAudio: boolean, minMs: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const peak of peaks) {
    const anchor = anchorOf(peak, hasAudio);
    const home = clusters.find((c) => Math.abs(anchor - c.mainAnchorMs) < minMs);
    if (!home) {
      clusters.push({
        main: peak,
        mainAnchorMs: anchor,
        firstAnchorMs: anchor,
        firstWindowStartMs: peak.startMs,
        lastAnchorMs: anchor,
        lastWindowEndMs: peak.endMs,
      });
      continue;
    }
    if (anchor < home.firstAnchorMs) {
      home.firstAnchorMs = anchor;
      home.firstWindowStartMs = Math.min(home.firstWindowStartMs, peak.startMs);
    }
    if (anchor > home.lastAnchorMs) {
      home.lastAnchorMs = anchor;
      home.lastWindowEndMs = Math.max(home.lastWindowEndMs, peak.endMs);
    }
  }
  return clusters;
}

function rangeFor(
  cluster: Cluster,
  silences: readonly FeatureSilence[],
  durationMs: number,
  opts: RankOptions,
): Range {
  // Start at the end of the pause that leads into the highlight, so the clip opens on the
  // first word or beat rather than mid-sentence; otherwise give a few seconds of lead-in.
  let startMs = cluster.firstWindowStartMs - PAD_MS;
  let startSnap: RangeSnap = 'padded';
  const earliest = cluster.firstWindowStartMs - SILENCE_LOOKBACK_MS;
  for (const s of silences) {
    if (s.endMs > cluster.firstAnchorMs) continue;
    if (s.endMs >= earliest && (startSnap !== 'silence' || s.endMs > startMs)) {
      startMs = s.endMs;
      startSnap = 'silence';
    }
  }
  if (startMs <= 0) {
    startMs = 0;
    if (startSnap !== 'silence') startSnap = 'source_start';
  }

  let endMs = cluster.lastWindowEndMs + PAD_MS;
  let endSnap: RangeSnap = 'padded';
  const nextPause = silences.find(
    (s) =>
      s.startMs > cluster.lastAnchorMs && s.startMs > startMs && s.startMs <= startMs + opts.maxMs,
  );
  if (nextPause) {
    endMs = nextPause.startMs;
    endSnap = 'silence';
  }

  if (endMs - startMs < opts.minMs) {
    endMs = startMs + opts.minMs;
    endSnap = 'min_length';
  } else if (endMs - startMs > opts.maxMs) {
    endMs = startMs + opts.maxMs;
    endSnap = 'max_length';
  }
  if (endMs >= durationMs) {
    if (endMs > durationMs || endSnap !== 'silence') endSnap = 'source_end';
    endMs = durationMs;
    // Callers guarantee durationMs >= minMs here, so the start can always move back far enough.
    if (endMs - startMs < opts.minMs) {
      startMs = Math.max(0, endMs - opts.minMs);
      startSnap = startMs === 0 ? 'source_start' : 'min_length';
    }
  }
  return { startMs, endMs, startSnap, endSnap };
}

function iou(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (overlap <= 0) return 0;
  const union = Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs);
  return overlap / union;
}

function countInRange(sorted: readonly number[], startMs: number, endMs: number): number {
  let n = 0;
  for (const t of sorted) {
    if (t >= endMs) break;
    if (t >= startMs) n++;
  }
  return n;
}

function buildReason(input: {
  wholeSource: boolean;
  minMs: number;
  audioDriven: boolean;
  peakMs: number | null;
  levelRatio: number | null;
  sceneChanges: number;
  range: Range;
  hasAudio: boolean;
}): string {
  const parts: string[] = [];
  const cuts = `${input.sceneChanges} scene ${input.sceneChanges === 1 ? 'change' : 'changes'}`;
  if (input.wholeSource) {
    parts.push(
      `Whole video suggested: it is shorter than the ${Math.round(input.minMs / 1000)} s minimum clip length`,
    );
  }
  if (input.audioDriven && input.peakMs !== null) {
    const level =
      input.levelRatio !== null && input.levelRatio >= 1.05
        ? `, ${formatRatio(input.levelRatio)} the typical level`
        : '';
    parts.push(`Audio peak at ${formatTimecode(input.peakMs)}${level}`);
    if (input.sceneChanges > 0) parts.push(cuts);
  } else if (input.sceneChanges > 0) {
    const near = input.peakMs !== null ? ` around ${formatTimecode(input.peakMs)}` : '';
    parts.push(`${cuts}${near}`);
    // Say so rather than let a cut-only suggestion read as if the audio had been weighed.
    if (!input.hasAudio) parts.push('no audio to analyse');
  }
  if (!input.wholeSource) {
    if (input.range.startSnap === 'silence') {
      parts.push(`starts after a pause at ${formatTimecode(input.range.startMs)}`);
    }
    if (input.range.endSnap === 'silence') {
      parts.push(`ends at a pause at ${formatTimecode(input.range.endMs)}`);
    }
  }
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatRatio(ratio: number): string {
  if (ratio >= 100) return 'over 100x';
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}x`;
}

/** `mm:ss`, or `h:mm:ss` from one hour, truncated so it names the second the moment falls in. */
function formatTimecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
