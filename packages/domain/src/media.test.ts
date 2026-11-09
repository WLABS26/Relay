import { describe, expect, it } from 'vitest';
import {
  allowedTypeFor,
  extensionOf,
  sanitizeFilename,
  sniffContainer,
  validateForDestination,
  validateProbe,
  type DestinationFormatProfile,
  type DestinationMediaItem,
  type MediaCaps,
  type ProbeStream,
  type ProbeSummary,
} from './media';

const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

describe('sniffContainer', () => {
  it.each<[string, Uint8Array, string]>([
    ['JPEG', bytes([0xff, 0xd8, 0xff, 0xe0]), 'jpeg'],
    ['PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png'],
    ['WebP', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'webp'],
    ['WebM', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm'), 'webm'],
    ['Matroska', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], 'matroska'), 'matroska'],
    ['MP4', bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0]), 'mp4'],
    ['QuickTime brand', bytes([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 0, 0]), 'mov'],
    ['QuickTime without ftyp', bytes([0, 0, 0, 0x08], 'wide', [0, 0, 0, 0]), 'mov'],
    ['GIF', bytes('GIF89a', [0, 0, 0, 0, 0, 0]), 'unknown'],
    ['too short', bytes([0xff, 0xd8]), 'unknown'],
  ])('identifies %s from magic bytes', (_, b, expected) => {
    expect(sniffContainer(b)).toBe(expected);
  });
});

describe('upload names and types', () => {
  it('matches declared types case-insensitively and knows nothing else', () => {
    expect(allowedTypeFor('VIDEO/MP4')?.demuxer).toBe('mov');
    expect(allowedTypeFor('image/gif')).toBeUndefined();
    expect(allowedTypeFor('application/octet-stream')).toBeUndefined();
  });

  it('keeps a short, safe display name and strips spoofing characters', () => {
    expect(sanitizeFilename('C:\\Users\\me\\clip.mp4')).toBe('clip.mp4');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a\u0000b\u0007c<>:"|?*.png')).toBe('abc.png');
    expect(sanitizeFilename('photo\u202egpj.exe')).toBe('photogpj.exe'); // RTL override removed
    expect(sanitizeFilename('in\u200bvisible\ufeff.jpg')).toBe('invisible.jpg');
    expect(sanitizeFilename('   ')).toBe('upload');
    expect(sanitizeFilename(`${'x'.repeat(300)}.mp4`)).toHaveLength(120);
    expect(sanitizeFilename('Cafe\u0301 clip.mov')).toBe('Café clip.mov');
  });

  it('reads extensions without trusting anything else in the name', () => {
    expect(extensionOf('a.tar.MP4')).toBe('mp4');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('weird.toolongextension')).toBe('');
  });
});

const caps: MediaCaps = {
  maxVideoDurationMs: 60_000,
  maxVideoDimension: 3840,
  maxImagePixels: 50_000_000,
  maxStreams: 4,
};
const video = (s: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 0,
  type: 'video',
  codec: 'h264',
  codecTag: 'avc1',
  width: 1920,
  height: 1080,
  avgFrameRate: 30,
  realFrameRate: 30,
  ...s,
});
const audio = (s: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 1,
  type: 'audio',
  codec: 'aac',
  codecTag: 'mp4a',
  ...s,
});
const probe = (streams: ProbeStream[], p: Partial<ProbeSummary> = {}): ProbeSummary => ({
  formatName: 'mov,mp4',
  durationMs: 8000,
  startTimeMs: 0,
  bitRate: 1,
  streams,
  encrypted: false,
  ...p,
});
const failure = (kind: 'video' | 'image', p: ProbeSummary) => {
  const r = validateProbe(kind, p, caps);
  return r.ok ? null : r.code;
};

describe('validateProbe', () => {
  it('normalises a valid video, swapping dimensions for rotation', () => {
    const r = validateProbe('video', probe([video({ rotation: -90 }), audio()]), caps);
    expect(r).toMatchObject({
      ok: true,
      media: {
        width: 1080,
        height: 1920,
        rotation: 270,
        hasAudio: true,
        durationMs: 8000,
        variableFrameRate: false,
      },
    });
  });

  it('detects variable frame rate and silent video', () => {
    const r = validateProbe(
      'video',
      probe([video({ avgFrameRate: 29.2, realFrameRate: 30 })]),
      caps,
    );
    expect(r).toMatchObject({
      ok: true,
      media: { variableFrameRate: true, hasAudio: false, audioCodec: null },
    });
  });

  it.each<[string, 'video' | 'image', ProbeSummary, string]>([
    ['encrypted', 'video', probe([video()], { encrypted: true }), 'encrypted_media'],
    ['no streams', 'video', probe([]), 'malformed_media'],
    [
      'too many streams',
      'video',
      probe([video(), audio(), audio(), audio(), audio()]),
      'too_many_streams',
    ],
    ['cover art only', 'video', probe([video({ attachedPic: true }), audio()]), 'no_video_stream'],
    ['unknown video codec', 'video', probe([video({ codec: 'mpeg2video' })]), 'unsupported_codec'],
    [
      'unknown audio codec',
      'video',
      probe([video(), audio({ codec: 'dts' })]),
      'unsupported_codec',
    ],
    [
      'no duration',
      'video',
      probe([video({ durationMs: null })], { durationMs: null }),
      'malformed_media',
    ],
    ['too long', 'video', probe([video()], { durationMs: 60_001 }), 'too_long'],
    ['too wide', 'video', probe([video({ width: 4096, height: 2160 })]), 'dimensions_too_large'],
    ['image codec', 'image', probe([video({ codec: 'gif' })]), 'unsupported_codec'],
    [
      'image pixels',
      'image',
      probe([video({ codec: 'png', width: 10_000, height: 5_001 })]),
      'dimensions_too_large',
    ],
    ['no image', 'image', probe([audio()]), 'no_image_stream'],
  ])('rejects %s', (_, kind, p, code) => {
    expect(failure(kind, p)).toBe(code);
  });
});

const profile: DestinationFormatProfile = {
  source: 'Unit test profile',
  publishMode: 'api',
  video: {
    minDurationMs: 3000,
    maxDurationMs: 60_000,
    maxBytes: 100_000_000,
    aspect: { min: 0.5, max: 0.6 },
    containers: ['mp4'],
  },
  image: {
    maxBytes: 8_000_000,
    aspect: { min: 0.8, max: 1.91 },
    mimes: ['image/jpeg', 'image/png'],
  },
  carousel: { minItems: 2, maxItems: 3, allowVideo: false },
  visibilities: ['public', 'private'],
  captionMaxLength: 10,
  title: { required: true, maxLength: 5 },
};
const vertical: DestinationMediaItem = {
  kind: 'video',
  mime: 'video/mp4',
  sizeBytes: 1000,
  width: 1080,
  height: 1920,
  durationMs: 8000,
};
const photo: DestinationMediaItem = {
  kind: 'image',
  mime: 'image/jpeg',
  sizeBytes: 1000,
  width: 1080,
  height: 1350,
  durationMs: null,
};
const issues = (
  media: DestinationMediaItem[],
  extra: Partial<{
    caption: string;
    title: string | null;
    visibility: 'public' | 'private' | 'unlisted';
  }> = {},
) =>
  validateForDestination(profile, {
    media,
    caption: 'ok',
    title: 'T',
    visibility: 'public',
    ...extra,
  }).map((i) => i.code);

describe('validateForDestination', () => {
  it('accepts content that fits the destination profile', () => {
    expect(issues([vertical])).toEqual([]);
    expect(issues([photo, photo])).toEqual([]);
  });

  it('checks each rule of the profile', () => {
    expect(issues([])).toEqual(['media_required']);
    expect(issues([{ ...vertical, durationMs: 2000 }])).toEqual(['video_duration']);
    expect(issues([{ ...vertical, width: 1920, height: 1080 }])).toEqual(['video_aspect']);
    expect(issues([{ ...vertical, sizeBytes: 100_000_001 }])).toEqual(['video_too_large']);
    expect(issues([{ ...photo, mime: 'image/webp' }])).toEqual(['image_type']);
    expect(issues([photo, photo, photo, photo])).toEqual(['carousel_size']);
    expect(issues([photo, vertical])).toEqual(['carousel_video_unsupported']);
    expect(issues([vertical], { visibility: 'unlisted' })).toEqual(['visibility_unsupported']);
    expect(issues([vertical], { title: '  ' })).toEqual(['title_required']);
  });

  it('measures caption and title length in characters, not UTF-16 units', () => {
    expect(issues([vertical], { caption: '😀'.repeat(10) })).toEqual([]);
    expect(issues([vertical], { caption: '😀'.repeat(11) })).toEqual(['caption_too_long']);
    expect(issues([vertical], { title: '🎬🎬🎬🎬🎬' })).toEqual([]);
  });

  it('validates every carousel item and says which one failed', () => {
    const result = validateForDestination(profile, {
      media: [photo, { ...photo, mime: 'image/webp', sizeBytes: 9_000_000 }],
      caption: 'ok',
      title: 'T',
      visibility: 'public',
    });
    expect(result.map((i) => [i.code, i.message])).toEqual([
      ['image_type', 'Item 2: image/webp images are not accepted here.'],
      ['image_too_large', 'Item 2: Image is too large for this destination.'],
    ]);
  });

  it('reports only carousel_unsupported when a destination takes no carousels', () => {
    const { carousel: _omit, ...noCarousel } = profile;
    const result = validateForDestination(noCarousel, {
      media: [photo, { ...photo, mime: 'image/webp' }],
      caption: 'ok',
      title: 'T',
      visibility: 'public',
    });
    expect(result.map((i) => i.code)).toEqual(['carousel_unsupported']);
  });

  it('tolerates rounding in odd-sized media aspect ratios', () => {
    const exact916 = {
      ...profile,
      video: { ...profile.video!, aspect: { min: 9 / 16, max: 9 / 16 } },
    };
    const check = (w: number, h: number) =>
      validateForDestination(exact916, {
        media: [{ ...vertical, width: w, height: h }],
        caption: 'ok',
        title: 'T',
        visibility: 'public',
      }).map((i) => i.code);
    expect(check(1080, 1920)).toEqual([]);
    expect(check(721, 1279)).toEqual([]); // 0.5637, within rounding of 0.5625
    expect(check(1080, 1350)).toEqual(['video_aspect']); // 4:5 is not 9:16
  });
});
