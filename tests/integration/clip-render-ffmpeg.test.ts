import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '@relay/config';
import { REPO_ROOT } from '@relay/config/dotenv';
import {
  clipFrameCount,
  clipGeometry,
  cuesForRender,
  toAss,
  type ClipAspect,
  type ClipCropMode,
  type Cue,
} from '@relay/domain';
import {
  CLIP_CAPTIONS_FILE,
  CLIP_FONTS_DIR,
  CLIP_RENDERER_VERSION,
  ClipRenderInputError,
  ClipVerificationError,
  clipRendererVersion,
  ffmpegVersion,
  isFastStartMp4,
  prlimitAvailable,
  probeFile,
  renderClip,
  runToolOrThrow,
  stageCaptionFonts,
  ToolError,
  verifyClipOutput,
  type MediaToolConfig,
} from '@relay/media';
import { TIMECODE_FIXTURE, timecodeFrameFromLuma } from '@relay/media/fixtures';

/**
 * renderClip against real FFmpeg and the synthetic fixtures. No database or object storage:
 * every test renders into a scratch directory and reads the result back through the same
 * sandbox the worker uses.
 */

const config = parseConfig({ ...process.env });
const tools: MediaToolConfig = {
  ffmpegPath: config.media.ffmpegPath,
  ffprobePath: config.media.ffprobePath,
  timeoutSeconds: 120,
  memoryLimitMb: config.media.memoryLimitMb,
  threads: config.media.threads,
  usePrlimit: config.media.usePrlimit,
};
const fixture = (name: string) => path.join(REPO_ROOT, 'fixtures/media', name);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(config.media.scratchDir ?? tmpdir(), 'relay-clip-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = path.join(root, `case-${++counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

interface RenderCase {
  /** A fixture name, or an absolute path with its demuxer. */
  source: string;
  demuxer?: string;
  startMs: number;
  endMs: number;
  aspect?: ClipAspect;
  cropMode?: ClipCropMode;
  /** Cues on the source timeline, as stored on a revision. */
  cues?: Cue[];
  maxOutputBytes?: number;
  tools?: MediaToolConfig;
}

/** Probe, compute geometry, stage captions, render and verify: the worker's sequence. */
async function render(c: RenderCase) {
  const dir = await scratch();
  const inputPath = path.isAbsolute(c.source) ? c.source : fixture(c.source);
  const demuxer = c.demuxer ?? 'mov';
  const source = await probeFile(tools, inputPath, demuxer);
  const video = source.streams.find((s) => s.type === 'video');
  if (!video?.width || !video.height) throw new Error(`${c.source} has no video stream`);
  const sideways = video.rotation === 90 || video.rotation === 270;
  const geometry = clipGeometry({
    sourceWidth: sideways ? video.height : video.width,
    sourceHeight: sideways ? video.width : video.height,
    aspect: c.aspect ?? 'original',
    cropMode: c.cropMode ?? 'fill',
  });
  const hasAudio = source.streams.some((s) => s.type === 'audio');
  if (c.cues) {
    await stageCaptionFonts({ fontsDir: config.media.fontsDir, scratchDir: dir });
    await writeFile(
      path.join(dir, CLIP_CAPTIONS_FILE),
      toAss(cuesForRender(c.cues, c.startMs, c.endMs), {
        width: geometry.outWidth,
        height: geometry.outHeight,
        style: 'default',
      }),
    );
  }
  const outputPath = path.join(dir, 'clip.mp4');
  await renderClip(c.tools ?? tools, {
    inputPath,
    demuxer,
    outputPath,
    scratchDir: dir,
    startMs: c.startMs,
    endMs: c.endMs,
    geometry,
    hasAudio,
    captions: c.cues !== undefined,
    maxOutputBytes: c.maxOutputBytes ?? MAX_OUTPUT_BYTES,
  });
  const expected = {
    width: geometry.outWidth,
    height: geometry.outHeight,
    frameCount: clipFrameCount(c.startMs, c.endMs),
    hasAudio,
  };
  const probe = await verifyClipOutput(tools, outputPath, expected);
  return { dir, outputPath, geometry, expected, probe };
}

interface RegionStats {
  yAvg: number;
  yMin: number;
  yMax: number;
  uAvg: number;
  vAvg: number;
}

/**
 * Per-frame plane statistics of a region, read with `signalstats`. `crop` is a crop filter
 * argument (`w:h:x:y`, expressions allowed); `frame` limits the read to one frame index.
 */
async function regionStats(file: string, crop: string, frame?: number): Promise<RegionStats[]> {
  const dir = await scratch();
  const select = frame === undefined ? [] : [`select=eq(n\\,${frame})`];
  const filter = [...select, `crop=${crop}`, 'signalstats', 'metadata=mode=print:file=stats.txt'];
  await runToolOrThrow(
    tools.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      filter.join(','),
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 60_000, usePrlimit: false },
    { cwd: dir },
  );
  const text = await readFile(path.join(dir, 'stats.txt'), 'utf8');
  const frames: RegionStats[] = [];
  let current: Record<string, number> | null = null;
  const flush = () => {
    if (!current) return;
    frames.push({
      yAvg: current.YAVG ?? NaN,
      yMin: current.YMIN ?? NaN,
      yMax: current.YMAX ?? NaN,
      uAvg: current.UAVG ?? NaN,
      vAvg: current.VAVG ?? NaN,
    });
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('frame:')) {
      flush();
      current = {};
    } else {
      const match = /^lavfi\.signalstats\.([A-Z]+)=(.+)$/.exec(line);
      if (match?.[1] && current) current[match[1]] = Number(match[2]);
    }
  }
  flush();
  return frames;
}

/** Source frame number shown by every frame of a clip cut from a timecode fixture. */
async function timecodeFrames(file: string): Promise<number[]> {
  const [left, right] = await Promise.all([
    regionStats(file, 'iw/2-16:ih:0:0'),
    regionStats(file, 'iw/2-16:ih:iw/2+16:0'),
  ]);
  expect(right).toHaveLength(left.length);
  return left.map((l, i) => timecodeFrameFromLuma(l.yAvg, right[i]?.yAvg ?? NaN));
}

const sequence = (first: number, count: number) =>
  Array.from({ length: count }, (_, i) => first + i);

/** Mono 48 kHz samples of the clip's audio track, decoded through its edit list. */
async function decodeAudio(file: string): Promise<Int16Array> {
  const result = await runToolOrThrow(
    tools.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      '-',
    ],
    { timeoutMs: 60_000, usePrlimit: false },
  );
  const bytes = result.stdout;
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

/**
 * Time (ms) at which a tone's period first drops below `maxPeriodSamples` and stays there:
 * the moment the fixture's stepping sine moves up to its next frequency.
 */
function toneStepMs(samples: Int16Array, maxPeriodSamples: number): number {
  const crossings: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] ?? 0) < 0 && (samples[i] ?? 0) >= 0) crossings.push(i);
  }
  for (let i = 0; i + 4 < crossings.length; i++) {
    const short = [1, 2, 3, 4].every(
      (k) => (crossings[i + k] ?? 0) - (crossings[i + k - 1] ?? 0) < maxPeriodSamples,
    );
    if (short) return ((crossings[i] ?? 0) / 48_000) * 1000;
  }
  return NaN;
}

describe('renderClip: frame-exact range', () => {
  it('cuts [2000, 5000) to exactly source frames 60..149', async () => {
    const { outputPath, probe } = await render({
      source: 'timecode-30fps.mp4',
      startMs: 2000,
      endMs: 5000,
    });
    expect(await timecodeFrames(outputPath)).toEqual(sequence(60, 90));
    const video = probe.streams.find((s) => s.type === 'video');
    expect(video).toMatchObject({ codec: 'h264', pixFmt: 'yuv420p', width: 1280, height: 720 });
    expect(video?.startTimeMs).toBe(0);
    expect(probe.streams.find((s) => s.type === 'audio')).toMatchObject({
      codec: 'aac',
      channels: 2,
      sampleRate: 48_000,
    });
  });

  it('starts on the next frame when the start is not on a keyframe or a frame boundary', async () => {
    // 2333 ms is just before frame 70 (2333.33 ms); the fixture has a keyframe every 30 frames.
    const { outputPath } = await render({
      source: 'timecode-30fps.mp4',
      startMs: 2333,
      endMs: 4333,
    });
    expect(await timecodeFrames(outputPath)).toEqual(sequence(70, 60));
  });

  it('gives the same frames when the container starts at a nonzero time', async () => {
    const source = await probeFile(tools, fixture('timecode-offset.mp4'), 'mov');
    const videoStart = source.streams.find((s) => s.type === 'video')?.startTimeMs ?? 0;
    // The fixture is only a test of this if the two start times differ (audio priming).
    expect(source.startTimeMs).toBeGreaterThan(0);
    expect(videoStart).toBe(TIMECODE_FIXTURE.offsetMs);
    expect(videoStart).toBeGreaterThan(source.startTimeMs ?? 0);

    const onGrid = await render({ source: 'timecode-offset.mp4', startMs: 2000, endMs: 5000 });
    expect(await timecodeFrames(onGrid.outputPath)).toEqual(sequence(60, 90));
    const offGrid = await render({ source: 'timecode-offset.mp4', startMs: 2333, endMs: 4333 });
    expect(await timecodeFrames(offGrid.outputPath)).toEqual(sequence(70, 60));
    const fromStart = await render({ source: 'timecode-offset.mp4', startMs: 0, endMs: 1000 });
    expect(await timecodeFrames(fromStart.outputPath)).toEqual(sequence(0, 30));
  });

  it('handles the first frame, the last frame and ranges off the frame grid', async () => {
    const head = await render({ source: 'timecode-30fps.mp4', startMs: 0, endMs: 1000 });
    expect(await timecodeFrames(head.outputPath)).toEqual(sequence(0, 30));

    const tail = await render({ source: 'timecode-30fps.mp4', startMs: 10_000, endMs: 12_000 });
    expect(await timecodeFrames(tail.outputPath)).toEqual(
      sequence(300, TIMECODE_FIXTURE.frames - 300),
    );

    // 2010 ms falls between frames 60 and 61: the clip holds grid points 61..150.
    const between = await render({ source: 'timecode-30fps.mp4', startMs: 2010, endMs: 5010 });
    expect(await timecodeFrames(between.outputPath)).toEqual(sequence(61, 90));

    // Adjacent ranges neither share nor drop a frame.
    const first = await render({ source: 'timecode-30fps.mp4', startMs: 1000, endMs: 2017 });
    const second = await render({ source: 'timecode-30fps.mp4', startMs: 2017, endMs: 3000 });
    const joined = [
      ...(await timecodeFrames(first.outputPath)),
      ...(await timecodeFrames(second.outputPath)),
    ];
    expect(joined).toEqual(sequence(30, 60));

    // Shorter than one frame interval still yields one picture.
    const single = await render({ source: 'timecode-30fps.mp4', startMs: 2017, endMs: 2035 });
    expect(await timecodeFrames(single.outputPath)).toEqual([61]);
  });

  it('is exact on a Matroska source, whose timestamps are whole milliseconds', async () => {
    // The same packets in Matroska: frame times are rounded to the millisecond (frame 61 is
    // stamped 2033 ms, a third of a millisecond before its grid point) and the video track
    // starts 21 ms after the audio.
    const dir = await scratch();
    const mkv = path.join(dir, 'timecode.mkv');
    await runToolOrThrow(
      tools.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        fixture('timecode-30fps.mp4'),
        '-c',
        'copy',
        '-f',
        'matroska',
        mkv,
      ],
      { timeoutMs: 60_000, usePrlimit: false },
    );
    const cases: Array<[number, number, number]> = [
      [0, 1000, 0],
      [2000, 5000, 60],
      [2033, 4033, 61],
      [2034, 4034, 62],
    ];
    for (const [startMs, endMs, first] of cases) {
      const { outputPath, expected } = await render({
        source: mkv,
        demuxer: 'matroska',
        startMs,
        endMs,
      });
      expect(await timecodeFrames(outputPath), `[${startMs}, ${endMs})`).toEqual(
        sequence(first, expected.frameCount),
      );
    }
  });

  it('keeps sound aligned with the picture', async () => {
    // The fixture's tone steps up every second: 440 -> 550 Hz at 3 s, 550 -> 660 Hz at 4 s.
    // A clip starting at 2500 ms must therefore step 500 ms in.
    for (const source of ['timecode-30fps.mp4', 'timecode-offset.mp4']) {
      const { outputPath } = await render({ source, startMs: 2500, endMs: 4500 });
      const samples = await decodeAudio(outputPath);
      expect(samples.length / 48).toBeGreaterThan(1950);
      expect(samples.length / 48).toBeLessThan(2050);
      // 440 Hz is 109 samples per cycle, 550 Hz is 87.
      const step = toneStepMs(samples, 98);
      expect(Math.abs(step - 500), `${source}: tone stepped at ${step} ms`).toBeLessThan(8);
    }
  });

  it('keeps a full-length audio track when the source audio ends before the range', async () => {
    // The same picture with the audio cut at 2 s: a range after that has no source sound.
    const dir = await scratch();
    const shortAudio = path.join(dir, 'short-audio.mp4');
    await runToolOrThrow(
      tools.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        fixture('timecode-30fps.mp4'),
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-af',
        'atrim=end=2',
        '-f',
        'mp4',
        shortAudio,
      ],
      { timeoutMs: 60_000, usePrlimit: false },
    );
    // Entirely past the audio, and straddling its end: both verify with an AAC track.
    for (const [startMs, endMs] of [
      [3000, 5000],
      [1000, 4000],
    ] as const) {
      const { outputPath } = await render({ source: shortAudio, startMs, endMs });
      expect(await timecodeFrames(outputPath)).toEqual(
        sequence((startMs * 30) / 1000, ((endMs - startMs) * 30) / 1000),
      );
      const ms = (await decodeAudio(outputPath)).length / 48;
      expect(Math.abs(ms - (endMs - startMs)), `[${startMs}, ${endMs})`).toBeLessThan(50);
    }
  });
});

describe('renderClip: geometry', () => {
  it('renders odd 4:4:4 sources at even 4:2:0 dimensions', async () => {
    const { probe, geometry } = await render({
      source: 'odd-721x1279-3s.mp4',
      startMs: 0,
      endMs: 2000,
      aspect: 'original',
    });
    expect(geometry).toMatchObject({ outWidth: 720, outHeight: 1278 });
    expect(probe.streams.find((s) => s.type === 'video')).toMatchObject({
      width: 720,
      height: 1278,
      pixFmt: 'yuv420p',
    });
  });

  it('renders a source without audio as video only', async () => {
    const { probe } = await render({
      source: 'square-720-noaudio-4s.mp4',
      startMs: 500,
      endMs: 3500,
      aspect: '1:1',
    });
    expect(probe.streams.map((s) => s.type)).toEqual(['video']);
    expect(probe.streams[0]).toMatchObject({ width: 720, height: 720 });
  });

  it('applies the source rotation and writes no rotation tag', async () => {
    const { outputPath, probe } = await render({
      source: 'rotated-90-5s.mp4',
      startMs: 1000,
      endMs: 3000,
      aspect: '9:16',
      cropMode: 'fill',
    });
    const video = probe.streams.find((s) => s.type === 'video');
    expect(video).toMatchObject({ width: 720, height: 1280, rotation: 0 });
    // The coded frame is the landscape test pattern: red bar on the left, cyan on the right.
    // Turned 90 degrees clockwise for display, red is the top band and cyan the bottom one.
    const [top] = await regionStats(outputPath, '48:48:120:60', 0);
    const [bottom] = await regionStats(outputPath, '48:48:120:ih-108', 0);
    expect(top?.vAvg).toBeGreaterThan(180);
    expect(top?.uAvg).toBeLessThan(128);
    expect(bottom?.vAvg).toBeLessThan(80);
    expect(bottom?.uAvg).toBeGreaterThan(128);
  });

  it('pads with black for fit and crops for fill', async () => {
    const fit = await render({
      source: 'landscape-1280x720-6s.mp4',
      startMs: 1000,
      endMs: 2000,
      aspect: '9:16',
      cropMode: 'fit',
    });
    expect(fit.geometry).toMatchObject({ outWidth: 1080, outHeight: 1920 });
    expect(fit.geometry.padY).toBeGreaterThan(600);
    for (const rows of ['iw:16:0:0', 'iw:16:0:ih-16']) {
      const [edge] = await regionStats(fit.outputPath, rows, 0);
      expect(edge?.yMax).toBeLessThanOrEqual(20);
    }
    const [middle] = await regionStats(fit.outputPath, 'iw:16:0:ih/2', 0);
    expect(middle?.yAvg).toBeGreaterThan(40);

    const fill = await render({
      source: 'landscape-1280x720-6s.mp4',
      startMs: 1000,
      endMs: 2000,
      aspect: '9:16',
      cropMode: 'fill',
    });
    // A 720-line source is not upscaled: the vertical window keeps the full height.
    expect(fill.geometry).toMatchObject({ outWidth: 404, outHeight: 720 });
    for (const rows of ['iw:16:0:0', 'iw:16:0:ih-16']) {
      const [edge] = await regionStats(fill.outputPath, rows, 0);
      expect(edge?.yAvg).toBeGreaterThan(40);
    }
  });
});

describe('renderClip: captions', () => {
  // Timecode frames are flat greys no brighter than luma 184, so white caption text shows up
  // as a jump in the region's maximum luma.
  const lowerThird = 'iw:ih/3:0:2*ih/3';
  const upperThird = 'iw:ih/3:0:0';
  const range = { source: 'timecode-30fps.mp4', startMs: 4000, endMs: 7000 };

  it('burns a cue into the lower third only while it is on screen', async () => {
    const plain = await render(range);
    // Cues are stored on the source timeline: 5-6 s there is 1-2 s in the clip.
    const captioned = await render({
      ...range,
      cues: [{ startMs: 5000, endMs: 6000, text: 'Hello from Relay' }],
    });
    expect(await timecodeFrames(captioned.outputPath)).toEqual(sequence(120, 90));

    const during = 45; // 1.5 s
    const after = 75; // 2.5 s
    const [plainDuring] = await regionStats(plain.outputPath, lowerThird, during);
    const [textDuring] = await regionStats(captioned.outputPath, lowerThird, during);
    expect(plainDuring?.yMax).toBeLessThan(200);
    expect(textDuring?.yMax).toBeGreaterThan(225);
    expect(textDuring?.yMin).toBeLessThan(24); // the black outline

    const [plainAfter] = await regionStats(plain.outputPath, lowerThird, after);
    const [textAfter] = await regionStats(captioned.outputPath, lowerThird, after);
    expect(textAfter?.yMax).toBe(plainAfter?.yMax);
    expect(textAfter?.yMin).toBe(plainAfter?.yMin);
    expect(Math.abs((textAfter?.yAvg ?? 0) - (plainAfter?.yAvg ?? 1))).toBeLessThan(0.5);

    // Cue boundaries are exact to the frame: frames 30..59 carry text, 29 and 60 do not.
    const all = await regionStats(captioned.outputPath, lowerThird);
    const lit = all.map((frame) => frame.yMax > 225);
    expect(lit.indexOf(true)).toBe(30);
    expect(lit.lastIndexOf(true)).toBe(59);
  });

  it('draws override syntax and filter metacharacters as literal text', async () => {
    const hostile = "{\\an8}{\\fs200}top\\N'[in];,=:%";
    const captioned = await render({
      ...range,
      cues: [{ startMs: 5000, endMs: 6000, text: hostile }],
    });
    const plain = await render(range);
    const frame = 45;
    // If `{\an8}` had been honoured the text would sit at the top of the frame.
    const [top] = await regionStats(captioned.outputPath, upperThird, frame);
    const [plainTop] = await regionStats(plain.outputPath, upperThird, frame);
    expect(top?.yMax).toBe(plainTop?.yMax);
    const [bottom] = await regionStats(captioned.outputPath, lowerThird, frame);
    expect(bottom?.yMax).toBeGreaterThan(225);
    // Literal text is one line at the caption size. An honoured `\N` or `\fs200` would make
    // the text block much taller than a single line (36 px font on a 720 px frame).
    const [aboveText] = await regionStats(captioned.outputPath, 'iw:ih/3-80:0:ih/3', frame);
    const [band] = await regionStats(captioned.outputPath, 'iw:100:0:ih-150', frame);
    expect(band?.yMax).toBeGreaterThan(225);
    expect(aboveText?.yMax).toBeLessThan(200);
  });

  it('refuses a caption render without the caption font or the caption file', async () => {
    const dir = await scratch();
    const geometry = clipGeometry({
      sourceWidth: 1280,
      sourceHeight: 720,
      aspect: 'original',
      cropMode: 'fill',
    });
    const request = {
      inputPath: fixture('timecode-30fps.mp4'),
      demuxer: 'mov',
      outputPath: path.join(dir, 'clip.mp4'),
      scratchDir: dir,
      startMs: 0,
      endMs: 1000,
      geometry,
      hasAudio: true,
      captions: true,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
    await writeFile(
      path.join(dir, CLIP_CAPTIONS_FILE),
      toAss([{ startMs: 0, endMs: 900, text: 'x' }], {
        width: 1280,
        height: 720,
        style: 'default',
      }),
    );
    await expect(renderClip(tools, request)).rejects.toMatchObject({
      name: 'ClipRenderInputError',
      code: 'fonts_missing',
    });
    // An empty fonts directory is as good as none: there is nothing to fall back to.
    await mkdir(path.join(dir, CLIP_FONTS_DIR));
    await expect(renderClip(tools, request)).rejects.toBeInstanceOf(ClipRenderInputError);
    expect(existsSync(request.outputPath)).toBe(false);

    await expect(
      stageCaptionFonts({ fontsDir: path.join(dir, 'no-such-dir'), scratchDir: dir }),
    ).rejects.toMatchObject({ code: 'fonts_missing' });

    const staged = await stageCaptionFonts({ fontsDir: config.media.fontsDir, scratchDir: dir });
    expect(staged.length).toBeGreaterThan(0);
    await rm(path.join(dir, CLIP_CAPTIONS_FILE));
    await expect(renderClip(tools, request)).rejects.toMatchObject({ code: 'captions_missing' });
  });
});

describe('renderClip: output contract and limits', () => {
  it('writes a fast-start MP4 that verification accepts, and rejects a wrong expectation', async () => {
    const { outputPath, expected } = await render({
      source: 'landscape-1280x720-6s.mp4',
      startMs: 1000,
      endMs: 3000,
    });
    expect(await isFastStartMp4(outputPath)).toBe(true);
    // The fixture that was written without +faststart-style layout is told apart.
    expect(await isFastStartMp4(fixture('truncated.mp4'))).toBe(false);

    await expect(
      verifyClipOutput(tools, outputPath, { ...expected, frameCount: expected.frameCount + 1 }),
    ).rejects.toBeInstanceOf(ClipVerificationError);
    await expect(
      verifyClipOutput(tools, outputPath, { ...expected, width: 1080, height: 1920 }),
    ).rejects.toThrow(/size is 1280x720/);
    await expect(
      verifyClipOutput(tools, outputPath, { ...expected, hasAudio: false }),
    ).rejects.toThrow(/audio/);
    // A source file is not a clip: wrong rate bookkeeping aside, the frame count differs.
    await expect(
      verifyClipOutput(tools, fixture('square-720-noaudio-4s.mp4'), {
        width: 720,
        height: 720,
        frameCount: 60,
        hasAudio: false,
      }),
    ).rejects.toThrow(/frame count/);
  });

  it('drops source metadata from the clip', async () => {
    const { outputPath } = await render({
      source: 'landscape-1280x720-6s.mp4',
      startMs: 0,
      endMs: 1000,
    });
    const bytes = await readFile(outputPath);
    expect(bytes.includes(Buffer.from('Relay synthetic fixture'))).toBe(false);
  });

  it('fails with a ToolError and leaves no file when the output limit is hit', async () => {
    const dir = await scratch();
    const outputPath = path.join(dir, 'clip.mp4');
    const geometry = clipGeometry({
      sourceWidth: 1280,
      sourceHeight: 720,
      aspect: 'original',
      cropMode: 'fill',
    });
    await expect(
      renderClip(tools, {
        inputPath: fixture('landscape-1280x720-6s.mp4'),
        demuxer: 'mov',
        outputPath,
        scratchDir: dir,
        startMs: 0,
        endMs: 5000,
        geometry,
        hasAudio: true,
        captions: false,
        maxOutputBytes: 20_000,
      }),
    ).rejects.toBeInstanceOf(ToolError);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects ranges and geometry it cannot render before starting FFmpeg', async () => {
    const dir = await scratch();
    const geometry = clipGeometry({
      sourceWidth: 1280,
      sourceHeight: 720,
      aspect: 'original',
      cropMode: 'fill',
    });
    const request = {
      inputPath: fixture('landscape-1280x720-6s.mp4'),
      demuxer: 'mov',
      outputPath: path.join(dir, 'clip.mp4'),
      scratchDir: dir,
      startMs: 0,
      endMs: 1000,
      geometry,
      hasAudio: true,
      captions: false,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
    await expect(renderClip(tools, { ...request, endMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(renderClip(tools, { ...request, startMs: 0.5 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      renderClip(tools, { ...request, geometry: { ...geometry, outWidth: 1279 } }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      renderClip(tools, { ...request, geometry: { ...geometry, cropX: Number.NaN } }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(existsSync(request.outputPath)).toBe(false);
  });

  it('renders 1080x1920 inside the configured memory limit', async () => {
    // Without prlimit the limit is not enforced and this test would prove nothing.
    expect(prlimitAvailable()).toBe(true);
    const limited: MediaToolConfig = {
      ...tools,
      usePrlimit: true,
      memoryLimitMb: config.media.memoryLimitMb,
    };
    const { probe, outputPath } = await render({
      source: 'vertical-1080x1920-8s.mp4',
      startMs: 1000,
      endMs: 7000,
      aspect: '9:16',
      cropMode: 'fill',
      tools: limited,
    });
    expect(probe.streams.find((s) => s.type === 'video')).toMatchObject({
      width: 1080,
      height: 1920,
    });
    // 8 Mbit/s cap plus audio over 6 s, with slack for the container.
    expect((await stat(outputPath)).size).toBeLessThan(7 * 1024 * 1024);
  });

  it('reports a renderer version that names the recipe and the encoder build', async () => {
    const version = clipRendererVersion(await ffmpegVersion(tools));
    expect(version.startsWith(`${CLIP_RENDERER_VERSION} (ffmpeg version `)).toBe(true);
    expect(version.length).toBeLessThanOrEqual(120);
  });
});
