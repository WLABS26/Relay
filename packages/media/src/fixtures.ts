import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runToolOrThrow } from './process';

/**
 * Synthetic media fixtures, generated deterministically from FFmpeg's lavfi sources with
 * bit-exact flags. They contain no people, no personal data and no third-party content, and
 * every file carries a "Relay synthetic fixture" comment. Edge cases (rotation, odd
 * dimensions, no audio) and hostile inputs (malformed, mislabeled, truncated, encrypted) are
 * included so validation paths are exercised end to end.
 */

export interface FixtureSpec {
  name: string;
  mime: string;
  kind: 'video' | 'image' | 'invalid';
  description: string;
  expect: {
    valid: boolean;
    width?: number;
    height?: number;
    durationMs?: number;
    hasAudio?: boolean;
    rejection?: string;
  };
}

export interface FixtureManifest {
  generator: string;
  files: Array<FixtureSpec & { sizeBytes: number; sha256: string }>;
}

const BITEXACT = [
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact',
  '-map_metadata',
  '-1',
];
const TAG = ['-metadata', 'comment=Relay synthetic fixture'];

function x264(extra: string[] = []): string[] {
  return [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-g',
    '30',
    '-threads',
    '1',
    ...extra,
  ];
}

export const FIXTURES: FixtureSpec[] = [
  {
    name: 'vertical-1080x1920-8s.mp4',
    mime: 'video/mp4',
    kind: 'video',
    description: '9:16 test pattern with a beeping tone, 8 s, 30 fps',
    expect: { valid: true, width: 1080, height: 1920, durationMs: 8000, hasAudio: true },
  },
  {
    name: 'landscape-1280x720-6s.mp4',
    mime: 'video/mp4',
    kind: 'video',
    description: '16:9 test pattern with tone, 6 s',
    expect: { valid: true, width: 1280, height: 720, durationMs: 6000, hasAudio: true },
  },
  {
    name: 'square-720-noaudio-4s.mp4',
    mime: 'video/mp4',
    kind: 'video',
    description: '1:1 test pattern without an audio stream, 4 s',
    expect: { valid: true, width: 720, height: 720, durationMs: 4000, hasAudio: false },
  },
  {
    name: 'rotated-90-5s.mp4',
    mime: 'video/mp4',
    kind: 'video',
    description: '1280×720 coded frames with 90° rotation metadata (displays 720×1280)',
    expect: { valid: true, width: 720, height: 1280, durationMs: 5000, hasAudio: true },
  },
  {
    name: 'odd-721x1279-3s.mp4',
    mime: 'video/mp4',
    kind: 'video',
    description: 'Odd dimensions (yuv444p), 3 s',
    expect: { valid: true, width: 721, height: 1279, durationMs: 3000, hasAudio: false },
  },
  {
    name: 'portrait-1080x1350.jpg',
    mime: 'image/jpeg',
    kind: 'image',
    description: '4:5 still frame',
    expect: { valid: true, width: 1080, height: 1350 },
  },
  {
    name: 'square-1080.png',
    mime: 'image/png',
    kind: 'image',
    description: '1:1 still frame',
    expect: { valid: true, width: 1080, height: 1080 },
  },
  {
    name: 'landscape-1600x900.jpg',
    mime: 'image/jpeg',
    kind: 'image',
    description: '16:9 still frame',
    expect: { valid: true, width: 1600, height: 900 },
  },
  {
    name: 'malformed.mp4',
    mime: 'video/mp4',
    kind: 'invalid',
    description: 'An ftyp box followed by pseudo-random bytes',
    expect: { valid: false, rejection: 'malformed_media' },
  },
  {
    name: 'mislabeled-video.png',
    mime: 'image/png',
    kind: 'invalid',
    description: 'An MP4 file declared as image/png',
    expect: { valid: false, rejection: 'mime_mismatch' },
  },
  {
    name: 'truncated.mp4',
    mime: 'video/mp4',
    kind: 'invalid',
    description: 'The first 40% of an MP4 whose moov box is at the end',
    expect: { valid: false, rejection: 'malformed_media' },
  },
  {
    name: 'encrypted-cenc.mp4',
    mime: 'video/mp4',
    kind: 'invalid',
    description: 'CENC (AES-CTR) encrypted MP4 with a throwaway test key',
    expect: { valid: false, rejection: 'encrypted_media' },
  },
];

export async function generateFixtures(options: {
  outDir: string;
  ffmpegPath?: string;
}): Promise<FixtureManifest> {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const dir = options.outDir;
  await mkdir(dir, { recursive: true });
  const out = (name: string) => path.join(dir, name);
  const run = (args: string[]) =>
    runToolOrThrow(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
      timeoutMs: 120_000,
      usePrlimit: false,
    });
  const tone = (seconds: number) => [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:beep_factor=4:sample_rate=48000:duration=${seconds}`,
  ];
  const pattern = (w: number, h: number, seconds: number, rate = 30) => [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${w}x${h}:rate=${rate}:duration=${seconds}`,
  ];
  const aac = ['-c:a', 'aac', '-b:a', '64k', '-ac', '1'];

  await run([
    ...pattern(1080, 1920, 8),
    ...tone(8),
    ...x264(['-pix_fmt', 'yuv420p']),
    ...aac,
    '-shortest',
    '-movflags',
    '+faststart',
    ...BITEXACT,
    ...TAG,
    out('vertical-1080x1920-8s.mp4'),
  ]);
  await run([
    ...pattern(1280, 720, 6),
    ...tone(6),
    ...x264(['-pix_fmt', 'yuv420p']),
    ...aac,
    '-shortest',
    '-movflags',
    '+faststart',
    ...BITEXACT,
    ...TAG,
    out('landscape-1280x720-6s.mp4'),
  ]);
  await run([
    ...pattern(720, 720, 4),
    ...x264(['-pix_fmt', 'yuv420p']),
    '-movflags',
    '+faststart',
    ...BITEXACT,
    ...TAG,
    out('square-720-noaudio-4s.mp4'),
  ]);
  // Rotation: encode landscape, then stream-copy with a 90° display matrix.
  const unrotated = out('.rotated-src.mp4');
  await run([
    ...pattern(1280, 720, 5),
    ...tone(5),
    ...x264(['-pix_fmt', 'yuv420p']),
    ...aac,
    '-shortest',
    ...BITEXACT,
    unrotated,
  ]);
  await run([
    '-display_rotation:v:0',
    '-90',
    '-i',
    unrotated,
    '-c',
    'copy',
    ...BITEXACT,
    ...TAG,
    out('rotated-90-5s.mp4'),
  ]);
  await rm(unrotated, { force: true });
  // lavfi sources round to even sizes, so crop a larger pattern down to odd dimensions.
  await run([
    ...pattern(722, 1280, 3),
    '-vf',
    'format=yuv444p,crop=721:1279:0:0',
    ...x264(['-pix_fmt', 'yuv444p']),
    '-movflags',
    '+faststart',
    ...BITEXACT,
    ...TAG,
    out('odd-721x1279-3s.mp4'),
  ]);

  const still = (w: number, h: number) => [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${w}x${h}:rate=1:duration=1`,
    '-frames:v',
    '1',
  ];
  await run([
    ...still(1080, 1350),
    '-q:v',
    '3',
    ...BITEXACT,
    ...TAG,
    out('portrait-1080x1350.jpg'),
  ]);
  await run([...still(1080, 1080), ...BITEXACT, out('square-1080.png')]);
  await run([...still(1600, 900), '-q:v', '3', ...BITEXACT, ...TAG, out('landscape-1600x900.jpg')]);

  // Hostile inputs.
  const ftyp = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const noise = Buffer.alloc(64 * 1024);
  let seed = 0x5eed;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    noise[i] = seed >>> 24;
  }
  await writeFile(out('malformed.mp4'), Buffer.concat([ftyp, noise]));
  await writeFile(out('mislabeled-video.png'), await readFile(out('square-720-noaudio-4s.mp4')));
  const moovAtEnd = out('.moov-at-end.mp4');
  await run([...pattern(640, 360, 4), ...x264(['-pix_fmt', 'yuv420p']), ...BITEXACT, moovAtEnd]);
  const full = await readFile(moovAtEnd);
  await writeFile(out('truncated.mp4'), full.subarray(0, Math.floor(full.length * 0.4)));
  await rm(moovAtEnd, { force: true });
  await run([
    '-i',
    out('square-720-noaudio-4s.mp4'),
    '-c',
    'copy',
    '-encryption_scheme',
    'cenc-aes-ctr',
    '-encryption_key',
    '00112233445566778899aabbccddeeff',
    '-encryption_kid',
    'ffeeddccbbaa99887766554433221100',
    ...BITEXACT,
    out('encrypted-cenc.mp4'),
  ]);

  const files: FixtureManifest['files'] = [];
  for (const spec of FIXTURES) {
    const data = await readFile(out(spec.name));
    const { size } = await stat(out(spec.name));
    files.push({
      ...spec,
      sizeBytes: size,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  const manifest: FixtureManifest = { generator: 'relay-fixtures@1', files };
  await writeFile(out('manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
