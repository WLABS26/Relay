import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANK_OPTIONS,
  RANKER_VERSION,
  RANKER_WEIGHTS,
  downsampleEnvelope,
  rankHighlights,
  type FeatureSilence,
  type HighlightFeatures,
  type RankResult,
} from './ranker';

const MINUTE = 60_000;

interface Burst {
  startMs: number;
  endMs: number;
  db: number;
}

/** A flat envelope with louder bursts; listed silences are also written into the RMS series. */
function synthetic(input: {
  durationMs: number;
  baseDb?: number;
  bursts?: Burst[];
  silences?: FeatureSilence[];
  sceneChangesMs?: number[];
}): HighlightFeatures {
  const rmsDb = Array.from({ length: Math.ceil(input.durationMs / 100) }, (_, i) => {
    const t = i * 100;
    if (input.silences?.some((s) => t >= s.startMs && t < s.endMs)) return -90;
    const burst = input.bursts?.find((b) => t >= b.startMs && t < b.endMs);
    return burst ? burst.db : (input.baseDb ?? -40);
  });
  return {
    durationMs: input.durationMs,
    rmsDb,
    silences: input.silences ?? [],
    sceneChangesMs: input.sceneChangesMs ?? [],
  };
}

function burstAt(startMs: number, lengthMs = 6000, db = -10): Burst {
  return { startMs, endMs: startMs + lengthMs, db };
}

function expectWellFormed(result: RankResult, durationMs: number): void {
  expect(result.candidates.map((c) => c.rank)).toEqual(result.candidates.map((_, i) => i + 1));
  for (const c of result.candidates) {
    expect(Number.isInteger(c.startMs)).toBe(true);
    expect(Number.isInteger(c.endMs)).toBe(true);
    expect(c.startMs).toBeGreaterThanOrEqual(0);
    expect(c.endMs).toBeLessThanOrEqual(durationMs);
    expect(c.endMs).toBeGreaterThan(c.startMs);
    expect(c.score).toBeGreaterThanOrEqual(0);
    expect(c.score).toBeLessThanOrEqual(1);
    expect(c.confidence).toBeLessThanOrEqual(c.score);
    expect(c.reason.length).toBeGreaterThan(0);
    expect(c.reason.length).toBeLessThanOrEqual(500);
  }
  const scores = result.candidates.map((c) => c.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  expect(result.summary.candidateCount).toBe(result.candidates.length);
}

describe('rankHighlights', () => {
  it('finds the M2 synthetic peak: one burst at 04:00 between two silences', () => {
    const durationMs = 10 * MINUTE;
    const features = synthetic({
      durationMs,
      bursts: [burstAt(4 * MINUTE)],
      silences: [
        { startMs: 238_000, endMs: 240_000 },
        { startMs: 246_000, endMs: 248_000 },
      ],
    });
    const result = rankHighlights(features);

    expect(result.rankerVersion).toBe(RANKER_VERSION);
    expect(result.summary.noSignal).toBe(false);
    expectWellFormed(result, durationMs);
    expect(result.candidates).toHaveLength(1);

    const top = result.candidates[0]!;
    expect(top.rank).toBe(1);
    // Starts exactly where the preceding silence ends, and contains the whole burst.
    expect(top.startMs).toBe(240_000);
    expect(top.endMs).toBeGreaterThanOrEqual(246_000);
    expect(top.endMs - top.startMs).toBeGreaterThanOrEqual(15_000);
    expect(top.endMs - top.startMs).toBeLessThanOrEqual(60_000);
    expect(top.reason).toContain('Audio peak at 04:00');
    expect(top.reason).toContain('the typical level');
    expect(top.reason).toContain('starts after a pause at 04:00');
    expect(top.evidence.peakMs).toBe(240_000);
    expect(top.evidence.peakDb).toBe(-10);
    expect(top.evidence.levelRatio).toBeGreaterThan(10);
    expect(top.evidence.startSnap).toBe('silence');
    // Audio only: two of the three signals, fully sampled.
    expect(top.coverage).toBeCloseTo(2 / 3, 3);
    expect(top.confidence).toBeCloseTo(top.score * top.coverage, 3);
  });

  it('ends at the next pause when that already gives a long enough clip', () => {
    const features = synthetic({
      durationMs: 10 * MINUTE,
      bursts: [burstAt(4 * MINUTE, 20_000)],
      silences: [
        { startMs: 238_000, endMs: 240_000 },
        { startMs: 260_000, endMs: 262_000 },
      ],
    });
    const top = rankHighlights(features).candidates[0]!;
    expect([top.startMs, top.endMs]).toEqual([240_000, 260_000]);
    expect(top.reason).toContain('ends at a pause at 04:20');
  });

  it('pads around the peak window when there is no silence to snap to', () => {
    const top = rankHighlights(
      synthetic({ durationMs: 10 * MINUTE, bursts: [burstAt(4 * MINUTE)] }),
    ).candidates[0]!;
    expect(top.evidence.startSnap).toBe('padded');
    expect(top.startMs).toBeLessThan(240_000);
    expect(top.startMs).toBeGreaterThanOrEqual(240_000 - 8000);
    expect(top.endMs).toBeGreaterThanOrEqual(246_000);
    expect(top.reason).not.toContain('pause');
  });

  it('collapses two bursts 10 s apart into one candidate that covers both', () => {
    const durationMs = 10 * MINUTE;
    const result = rankHighlights(
      synthetic({ durationMs, bursts: [burstAt(240_000, 4000), burstAt(250_000, 4000)] }),
    );
    expectWellFormed(result, durationMs);
    expect(result.candidates).toHaveLength(1);
    const only = result.candidates[0]!;
    expect(only.startMs).toBeLessThanOrEqual(240_000);
    expect(only.endMs).toBeGreaterThanOrEqual(254_000);
  });

  it('keeps two bursts 3 minutes apart as two candidates', () => {
    const durationMs = 10 * MINUTE;
    const result = rankHighlights(
      synthetic({ durationMs, bursts: [burstAt(2 * MINUTE), burstAt(5 * MINUTE)] }),
    );
    expectWellFormed(result, durationMs);
    expect(result.candidates).toHaveLength(2);
    // Equal scores: the earlier range ranks first, so the order is stable.
    const [first, second] = result.candidates;
    expect(first!.score).toBe(second!.score);
    expect(first!.startMs).toBeLessThan(second!.startMs);
    expect(first!.reason).toContain('02:00');
    expect(second!.reason).toContain('05:00');
  });

  it('ranks a louder burst above a quieter one', () => {
    const result = rankHighlights(
      synthetic({
        durationMs: 10 * MINUTE,
        bursts: [burstAt(2 * MINUTE, 6000, -37), burstAt(5 * MINUTE, 6000, -10)],
      }),
    );
    expect(result.candidates[0]!.reason).toContain('05:00');
    expect(result.candidates[0]!.score).toBeGreaterThan(result.candidates[1]?.score ?? 0);
  });

  it('ranks on scene cuts alone without audio, at one third coverage', () => {
    const durationMs = 5 * MINUTE;
    const cuts: HighlightFeatures = {
      durationMs,
      rmsDb: null,
      silences: [],
      sceneChangesMs: [120_500, 121_800, 123_000],
    };
    const result = rankHighlights(cuts);
    expectWellFormed(result, durationMs);
    expect(result.summary).toMatchObject({ noSignal: false, hasAudio: false, signals: ['scene'] });
    expect(result.summary.coverage).toBeCloseTo(1 / 3, 3);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);

    const top = result.candidates[0]!;
    expect(top.startMs).toBeLessThanOrEqual(120_500);
    expect(top.endMs).toBeGreaterThan(123_000);
    expect(top.coverage).toBeCloseTo(1 / 3, 3);
    expect(top.confidence).toBeCloseTo(top.score / 3, 3);
    expect(top.reason).toContain('3 scene changes');
    expect(top.reason).toContain('no audio');
    expect(top.reason).not.toContain('Audio peak');
    expect(top.evidence.features.energy).toBeNull();

    // The same cuts backed by an audio burst are a more certain suggestion.
    const withAudio = rankHighlights({
      ...synthetic({ durationMs, bursts: [burstAt(120_000)] }),
      sceneChangesMs: cuts.sceneChangesMs,
    }).candidates[0]!;
    expect(withAudio.coverage).toBe(1);
    expect(withAudio.confidence).toBeGreaterThan(top.confidence);
    expect(withAudio.reason).toContain('3 scene changes');
  });

  it('returns nothing and flags noSignal without audio or cuts', () => {
    const result = rankHighlights({
      durationMs: 5 * MINUTE,
      rmsDb: null,
      silences: [],
      sceneChangesMs: [],
    });
    expect(result.candidates).toEqual([]);
    expect(result.summary.noSignal).toBe(true);
    expect(result.summary.coverage).toBe(0);
  });

  it('treats an envelope with no usable sample as no audio', () => {
    const result = rankHighlights({
      durationMs: 30_000,
      rmsDb: Array.from({ length: 300 }, () => Number.NaN),
      silences: [],
      sceneChangesMs: [],
    });
    expect(result.summary).toMatchObject({ noSignal: true, hasAudio: false });
  });

  it('suggests no candidate for flat audio, without calling it noSignal', () => {
    const result = rankHighlights(synthetic({ durationMs: 5 * MINUTE }));
    expect(result.candidates).toEqual([]);
    expect(result.summary.noSignal).toBe(false);
  });

  it('yields one whole-source candidate for a 9 s source', () => {
    const result = rankHighlights(synthetic({ durationMs: 9000, bursts: [burstAt(3000, 1000)] }));
    expectWellFormed(result, 9000);
    expect(result.candidates).toHaveLength(1);
    const only = result.candidates[0]!;
    expect([only.startMs, only.endMs]).toEqual([0, 9000]);
    expect(only.evidence.wholeSource).toBe(true);
    expect(only.reason).toContain('shorter than the 15 s minimum');

    // Still nothing to suggest when a short source has no signal at all.
    const silent = rankHighlights({
      durationMs: 9000,
      rmsDb: null,
      silences: [],
      sceneChangesMs: [],
    });
    expect(silent.candidates).toEqual([]);
    expect(silent.summary.noSignal).toBe(true);
  });

  it('is deterministic: the same input twice gives deep-equal output', () => {
    const make = () =>
      synthetic({
        durationMs: 10 * MINUTE,
        bursts: [burstAt(60_000), burstAt(4 * MINUTE, 8000, -6), burstAt(8 * MINUTE, 3000, -20)],
        silences: [{ startMs: 238_000, endMs: 240_000 }],
        sceneChangesMs: [61_000, 241_000, 242_500, 400_000],
      });
    const a = rankHighlights(make());
    const b = rankHighlights(make());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Input order of cuts and silences must not matter either.
    const shuffled = make();
    const c = rankHighlights({
      ...shuffled,
      sceneChangesMs: [...shuffled.sceneChangesMs].reverse(),
      silences: [...shuffled.silences].reverse(),
    });
    expect(c).toEqual(a);
  });

  it('keeps every candidate inside the source and ranks 1..n without gaps', () => {
    const durationMs = 3 * MINUTE;
    const result = rankHighlights(
      synthetic({
        durationMs,
        // Bursts hard against both ends, where padding would otherwise leave the source.
        bursts: [burstAt(0, 3000), burstAt(60_000), burstAt(90_000), burstAt(177_000, 3000)],
        sceneChangesMs: [500, 179_900],
      }),
    );
    expectWellFormed(result, durationMs);
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result.candidates.some((c) => c.startMs === 0)).toBe(true);
    expect(result.candidates.some((c) => c.endMs === durationMs)).toBe(true);
    for (const c of result.candidates) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(DEFAULT_RANK_OPTIONS.minMs);
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(DEFAULT_RANK_OPTIONS.maxMs);
    }
  });

  it('caps the number of candidates and honours option overrides', () => {
    const durationMs = 30 * MINUTE;
    const bursts = Array.from({ length: 20 }, (_, i) => burstAt((i + 1) * 80_000));
    const features = synthetic({ durationMs, bursts });
    expect(rankHighlights(features).candidates).toHaveLength(DEFAULT_RANK_OPTIONS.maxCandidates);
    const three = rankHighlights(features, { maxCandidates: 3 });
    expect(three.candidates).toHaveLength(3);
    expectWellFormed(three, durationMs);
    expect(() => rankHighlights(features, { strideMs: 0 })).toThrow(RangeError);
    expect(() => rankHighlights(features, { minMs: 60_000, maxMs: 30_000 })).toThrow(RangeError);
  });

  it('lowers confidence when the envelope is incomplete', () => {
    const full = synthetic({ durationMs: 5 * MINUTE, bursts: [burstAt(2 * MINUTE)] });
    // Half the samples inside the burst window are unusable.
    const patchy = {
      ...full,
      rmsDb: full.rmsDb!.map((db, i) => (i >= 1200 && i < 1250 && i % 2 === 1 ? Number.NaN : db)),
    };
    const a = rankHighlights(full).candidates[0]!;
    const b = rankHighlights(patchy).candidates[0]!;
    expect(b.coverage).toBeLessThan(a.coverage);
    expect(b.confidence).toBeLessThan(a.confidence);
  });

  it('does not read a gap in the envelope as an onset', () => {
    const flat = synthetic({ durationMs: 5 * MINUTE });
    const gappy = {
      ...flat,
      rmsDb: flat.rmsDb!.map((db, i) => (i >= 1200 && i < 1220 ? Number.NaN : db)),
      sceneChangesMs: [121_000, 122_000, 123_000],
    };
    const top = rankHighlights(gappy).candidates[0]!;
    expect(top.evidence.features.onset).toBe(0);
    expect(top.evidence.features.energy).toBe(0);
    expect(top.reason).not.toContain('Audio peak');
  });

  it('never reports a confidence above the score after rounding', () => {
    // Full coverage and a score whose third decimal rounds up (0.2816 -> 0.282).
    const durationMs = 17_710;
    const rmsDb = Array.from({ length: 178 }, (_, i) => (i >= 160 && i < 163 ? -10 : -40));
    const result = rankHighlights({
      durationMs,
      rmsDb,
      silences: [],
      sceneChangesMs: [13_000, 16_500],
    });
    expectWellFormed(result, durationMs);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores a scene change that rounds onto the end of the source', () => {
    const result = rankHighlights({
      durationMs: 30_000,
      rmsDb: null,
      silences: [],
      sceneChangesMs: [29_999.6, 30_000, -1],
    });
    expect(result.summary).toMatchObject({ noSignal: true, sceneChangeCount: 0 });
    expect(result.candidates).toEqual([]);
  });

  it('exposes weights that sum to 1', () => {
    expect(RANKER_WEIGHTS.energy + RANKER_WEIGHTS.onset + RANKER_WEIGHTS.scene).toBeCloseTo(1, 10);
  });
});

describe('downsampleEnvelope', () => {
  it('returns null without audio', () => {
    expect(downsampleEnvelope(null)).toBeNull();
    expect(downsampleEnvelope([])).toBeNull();
  });

  it('passes a short series through at the 100 ms hop', () => {
    expect(downsampleEnvelope([-40, -39.96, -10])).toEqual({ hopMs: 100, points: [-40, -40, -10] });
  });

  it('caps the point count and keeps short peaks visible', () => {
    const rms = Array.from({ length: 36_000 }, (_, i) => (i === 17_777 ? -3 : -40));
    const envelope = downsampleEnvelope(rms)!;
    expect(envelope.points.length).toBeLessThanOrEqual(2000);
    expect(envelope.hopMs).toBe(1800);
    expect(envelope.hopMs * envelope.points.length).toBeGreaterThanOrEqual(36_000 * 100);
    expect(Math.max(...envelope.points)).toBe(-3);
    expect(envelope.points[Math.floor(17_777 / 18)]).toBe(-3);
  });

  it('maps -inf and nan to the floor and validates maxPoints', () => {
    const envelope = downsampleEnvelope([Number.NEGATIVE_INFINITY, Number.NaN, -20], 3)!;
    expect(envelope.points).toEqual([-120, -120, -20]);
    expect(() => downsampleEnvelope([-20], 0)).toThrow(RangeError);
  });
});
