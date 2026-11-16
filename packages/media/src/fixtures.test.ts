import { describe, expect, it } from 'vitest';
import {
  FIXTURE_GENERATOR,
  FIXTURES,
  HIGHLIGHT_FIXTURE,
  TIMECODE_FIXTURE,
  timecodeFrameFromLuma,
} from './fixtures';

describe('fixture specs', () => {
  it('lists every file once, including the clipping fixtures', () => {
    const names = FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(['timecode-30fps.mp4', 'timecode-offset.mp4', 'highlight.mp4']),
    );
    expect(FIXTURE_GENERATOR).toBe('relay-fixtures@2');
  });

  it('keeps the highlight timeline consistent', () => {
    const { durationMs, silences, burst, sceneChangesMs } = HIGHLIGHT_FIXTURE;
    for (const s of silences) {
      // Detectable by silencedetect (d=0.4) and outside the burst.
      expect(s.endMs - s.startMs).toBeGreaterThan(400);
      expect(s.endMs <= burst.startMs || s.startMs >= burst.endMs).toBe(true);
    }
    expect(burst.endMs).toBeLessThan(durationMs);
    expect(sceneChangesMs.every((ms) => ms >= burst.startMs && ms < burst.endMs)).toBe(true);
  });
});

describe('timecodeFrameFromLuma', () => {
  const { base, step, modulus, frames } = TIMECODE_FIXTURE;
  const left = (n: number) => base + step * (n % modulus);
  const right = (n: number) => base + step * Math.floor(n / modulus);

  it('round-trips every frame and stays inside video range', () => {
    for (let n = 0; n < frames; n++) {
      expect(timecodeFrameFromLuma(left(n), right(n))).toBe(n);
      expect(left(n)).toBeLessThanOrEqual(235);
      expect(right(n)).toBeLessThanOrEqual(235);
    }
  });

  it('tolerates a few levels of encoding error', () => {
    expect(timecodeFrameFromLuma(left(149) + 3, right(149) - 3)).toBe(149);
    expect(timecodeFrameFromLuma(left(60) - 2.6, right(60) + 1.4)).toBe(60);
  });
});
