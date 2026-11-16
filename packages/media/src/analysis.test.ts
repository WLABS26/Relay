import { describe, expect, it } from 'vitest';
import {
  ANALYZER_VERSION,
  buildFeatures,
  MAX_SCENE_CHANGES,
  MAX_SILENCES,
  parseRmsFile,
  parseSceneFile,
  parseSilenceFile,
  RMS_FLOOR_DB,
} from './analysis';

// Captured from FFmpeg 6.1.1 on the highlight fixture (column padding as printed).
const RMS_SAMPLE = [
  'frame:0    pts:0       pts_time:0',
  'lavfi.astats.Overall.RMS_level=-29.018816',
  'frame:1    pts:800     pts_time:0.1',
  'lavfi.astats.Overall.RMS_level=-29.026737',
  'frame:2    pts:1600    pts_time:0.2',
  'lavfi.astats.Overall.RMS_level=-inf',
  'frame:3    pts:2400    pts_time:0.3',
  'lavfi.astats.Overall.RMS_level=-9.030526',
  '',
].join('\n');

const SILENCE_STARTS = [
  'frame:377  pts:301600  pts_time:37.7',
  'lavfi.silence_start=37.3999',
  'frame:463  pts:370400  pts_time:46.3',
  'lavfi.silence_start=46',
  '',
].join('\n');

const SILENCE_ENDS = [
  'frame:380  pts:304000  pts_time:38',
  'lavfi.silence_end=38.0003',
  'frame:466  pts:372800  pts_time:46.6',
  'lavfi.silence_end=46.6003',
  '',
].join('\n');

const SCENE_SAMPLE = [
  'frame:200  pts:200     pts_time:40',
  'lavfi.scd.time=40',
  'frame:215  pts:215     pts_time:43',
  'lavfi.scd.time=43',
  '',
].join('\n');

describe('parseRmsFile', () => {
  it('reads one level per 100 ms hop and maps -inf to the floor', () => {
    expect(parseRmsFile(RMS_SAMPLE, { durationMs: 1000 })).toEqual([
      -29.018816,
      -29.026737,
      RMS_FLOOR_DB,
      -9.030526,
    ]);
  });

  it('maps nan to the floor and clamps absurd levels', () => {
    const text = [
      'frame:0 pts:0 pts_time:0',
      'lavfi.astats.Overall.RMS_level=nan',
      'frame:1 pts:800 pts_time:0.1',
      'lavfi.astats.Overall.RMS_level=-250.5',
      'frame:2 pts:1600 pts_time:0.2',
      'lavfi.astats.Overall.RMS_level=inf',
      '',
    ].join('\n');
    expect(parseRmsFile(text, { durationMs: 1000 })).toEqual([RMS_FLOOR_DB, RMS_FLOOR_DB, 20]);
  });

  it('drops a truncated last line instead of reading it as a loud sample', () => {
    const cut = `${RMS_SAMPLE}frame:4    pts:3200    pts_time:0.4\nlavfi.astats.Overall.RMS_level=-2`;
    expect(parseRmsFile(cut, { durationMs: 1000 })).toHaveLength(4);
    // A header cut before its value line adds nothing either.
    expect(parseRmsFile(`${RMS_SAMPLE}frame:4    pts:32`, { durationMs: 1000 })).toHaveLength(4);
  });

  it('places samples by timestamp, so a missing frame leaves a floor-level gap', () => {
    const text = [
      'frame:0 pts:0 pts_time:0',
      'lavfi.astats.Overall.RMS_level=-20',
      'frame:3 pts:2400 pts_time:0.3',
      'lavfi.astats.Overall.RMS_level=-30',
      '',
    ].join('\n');
    expect(parseRmsFile(text, { durationMs: 1000 })).toEqual([
      -20,
      RMS_FLOOR_DB,
      RMS_FLOOR_DB,
      -30,
    ]);
  });

  it('ignores malformed lines, foreign keys and CRLF line endings', () => {
    const text = [
      'garbage without structure',
      'lavfi.astats.Overall.RMS_level=-10', // no frame header yet
      'frame:0 pts:0 pts_time:abc',
      'lavfi.astats.Overall.RMS_level=-11', // header without a usable time
      'frame:1 pts:800 pts_time:0.1\r',
      'lavfi.astats.Overall.RMS_level=-12.5\r',
      'lavfi.astats.1.RMS_level=-1',
      'frame:2 pts:1600 pts_time:0.2',
      'lavfi.astats.Overall.RMS_level=0x10',
      'frame:3 pts:2400 pts_time:0.3',
      'lavfi.astats.Overall.RMS_level=1e3',
      '',
    ].join('\n');
    expect(parseRmsFile(text, { durationMs: 1000 })).toEqual([RMS_FLOOR_DB, -12.5]);
  });

  it('never returns more points than the duration or the cap allow', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`frame:${i} pts:${i * 800} pts_time:${i / 10}`);
      lines.push('lavfi.astats.Overall.RMS_level=-20');
    }
    const text = `${lines.join('\n')}\n`;
    expect(parseRmsFile(text, { durationMs: 2000 })).toHaveLength(20);
    expect(parseRmsFile(text, { durationMs: 60_000, maxPoints: 7 })).toHaveLength(7);
    expect(parseRmsFile(text, { durationMs: 60_000 })).toHaveLength(50);
  });

  it('returns an empty envelope for empty or unusable input', () => {
    expect(parseRmsFile('', { durationMs: 1000 })).toEqual([]);
    expect(parseRmsFile('no newline at all', { durationMs: 1000 })).toEqual([]);
    expect(parseRmsFile(RMS_SAMPLE, { durationMs: 0 })).toEqual([]);
  });
});

describe('parseSilenceFile', () => {
  it('pairs starts and ends from the two concatenated files', () => {
    expect(parseSilenceFile(`${SILENCE_STARTS}${SILENCE_ENDS}`, { durationMs: 90_000 })).toEqual([
      { startMs: 37_400, endMs: 38_000 },
      { startMs: 46_000, endMs: 46_600 },
    ]);
  });

  it('closes an unterminated silence at the end of the source', () => {
    const text = `${SILENCE_STARTS}frame:880 pts:704000 pts_time:88\nlavfi.silence_start=87.5\n${SILENCE_ENDS}`;
    expect(parseSilenceFile(text, { durationMs: 90_000 })).toEqual([
      { startMs: 37_400, endMs: 38_000 },
      { startMs: 46_000, endMs: 46_600 },
      { startMs: 87_500, endMs: 90_000 },
    ]);
  });

  it('drops an end without a start and a truncated last line', () => {
    const text =
      'lavfi.silence_end=3.5\nlavfi.silence_start=10\nlavfi.silence_end=11.25\nlavfi.silence_start=2';
    expect(parseSilenceFile(text, { durationMs: 60_000 })).toEqual([
      { startMs: 10_000, endMs: 11_250 },
    ]);
  });

  it('clamps to the source, merges touching ranges and skips malformed values', () => {
    const text = [
      'lavfi.silence_start=-0.02',
      'lavfi.silence_end=1',
      'lavfi.silence_start=1',
      'lavfi.silence_end=2.5',
      'lavfi.silence_start=nan',
      'lavfi.silence_duration=1.5',
      'lavfi.silence_start=58',
      'lavfi.silence_end=75',
      '',
    ].join('\n');
    expect(parseSilenceFile(text, { durationMs: 60_000 })).toEqual([
      { startMs: 0, endMs: 2500 },
      { startMs: 58_000, endMs: 60_000 },
    ]);
  });

  it('caps starts and ends separately, so a long starts file cannot swallow the ends', () => {
    const count = MAX_SILENCES + 500;
    const starts: string[] = [];
    const ends: string[] = [];
    for (let i = 0; i < count; i++) {
      starts.push(`lavfi.silence_start=${i}`);
      ends.push(`lavfi.silence_end=${i}.5`);
    }
    // Same layout as extractFeatures: the whole starts file, then the whole ends file.
    const parsed = parseSilenceFile(`${starts.join('\n')}\n${ends.join('\n')}\n`, {
      durationMs: count * 1000,
    });
    expect(parsed).toHaveLength(MAX_SILENCES);
    expect(parsed[0]).toEqual({ startMs: 0, endMs: 500 });
    expect(parsed[MAX_SILENCES - 1]).toEqual({
      startMs: (MAX_SILENCES - 1) * 1000,
      endMs: (MAX_SILENCES - 1) * 1000 + 500,
    });
  });

  it('returns nothing for empty input', () => {
    expect(parseSilenceFile('', { durationMs: 1000 })).toEqual([]);
  });
});

describe('parseSceneFile', () => {
  it('reads scene-change times in milliseconds', () => {
    expect(parseSceneFile(SCENE_SAMPLE, { durationMs: 90_000 })).toEqual([40_000, 43_000]);
  });

  it('sorts, de-duplicates and drops times outside the source', () => {
    const text = [
      'lavfi.scd.time=43',
      'lavfi.scd.time=0',
      'lavfi.scd.time=40.0004',
      'lavfi.scd.time=40',
      'lavfi.scd.time=-1',
      'lavfi.scd.time=95',
      'lavfi.scd.score=55.1',
      'lavfi.scd.time=',
      'lavfi.scd.time=12.2', // truncated: no trailing newline
    ].join('\n');
    expect(parseSceneFile(text, { durationMs: 90_000 })).toEqual([40_000, 43_000]);
  });

  it('caps the number of scene changes', () => {
    const lines: string[] = [];
    for (let i = 1; i <= MAX_SCENE_CHANGES + 50; i++) lines.push(`lavfi.scd.time=${i}`);
    const parsed = parseSceneFile(`${lines.join('\n')}\n`, { durationMs: 1e9 });
    expect(parsed).toHaveLength(MAX_SCENE_CHANGES);
  });
});

describe('buildFeatures', () => {
  it('assembles the ranker input', () => {
    expect(
      buildFeatures({
        durationMs: 90_000,
        rms: RMS_SAMPLE,
        silence: `${SILENCE_STARTS}${SILENCE_ENDS}`,
        scene: SCENE_SAMPLE,
      }),
    ).toEqual({
      durationMs: 90_000,
      rmsDb: [-29.018816, -29.026737, RMS_FLOOR_DB, -9.030526],
      silences: [
        { startMs: 37_400, endMs: 38_000 },
        { startMs: 46_000, endMs: 46_600 },
      ],
      sceneChangesMs: [40_000, 43_000],
    });
  });

  it('reports no audio as a null envelope, not an empty one', () => {
    const features = buildFeatures({ durationMs: 4000, rms: null, silence: null, scene: '' });
    expect(features).toEqual({ durationMs: 4000, rmsDb: null, silences: [], sceneChangesMs: [] });
  });

  it('is deterministic', () => {
    const input = {
      durationMs: 90_000,
      rms: RMS_SAMPLE,
      silence: SILENCE_ENDS,
      scene: SCENE_SAMPLE,
    };
    expect(buildFeatures(input)).toEqual(buildFeatures(input));
  });

  it('exposes the analyzer version', () => {
    expect(ANALYZER_VERSION).toBe('relay-analyze@1');
  });
});
