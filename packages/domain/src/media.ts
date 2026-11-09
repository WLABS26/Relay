import type { Visibility } from './providers';

/**
 * Media rules shared by upload validation (server), the media worker and destination checks.
 * Platform limits are NOT global: each destination carries its own format profile.
 */

export type MediaKind = 'video' | 'image';
export type SniffedContainer = 'mp4' | 'mov' | 'webm' | 'matroska' | 'jpeg' | 'png' | 'webp' | 'unknown';

export interface AllowedMime {
  kind: MediaKind;
  extensions: readonly string[];
  /** Containers whose magic bytes are acceptable for this declared type. */
  containers: readonly SniffedContainer[];
  /** FFmpeg demuxer forced when probing (prevents format confusion attacks). */
  demuxer: string;
}

export const ALLOWED_UPLOAD_TYPES: Record<string, AllowedMime> = {
  'video/mp4': { kind: 'video', extensions: ['mp4', 'm4v'], containers: ['mp4', 'mov'], demuxer: 'mov' },
  'video/quicktime': { kind: 'video', extensions: ['mov'], containers: ['mov', 'mp4'], demuxer: 'mov' },
  'video/webm': { kind: 'video', extensions: ['webm'], containers: ['webm'], demuxer: 'matroska' },
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'], containers: ['jpeg'], demuxer: 'jpeg_pipe' },
  'image/png': { kind: 'image', extensions: ['png'], containers: ['png'], demuxer: 'png_pipe' },
  'image/webp': { kind: 'image', extensions: ['webp'], containers: ['webp'], demuxer: 'webp_pipe' },
};

export const ALLOWED_VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1', 'vp8'] as const;
export const ALLOWED_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'alac', 'pcm_s16le'] as const;
export const ALLOWED_IMAGE_CODECS = ['mjpeg', 'png', 'webp'] as const;

export function allowedTypeFor(mime: string): AllowedMime | undefined {
  return ALLOWED_UPLOAD_TYPES[mime.toLowerCase()];
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < Math.min(end, bytes.length); i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Identify a container from its leading bytes (needs ~64 bytes). Never trusts extensions. */
export function sniffContainer(bytes: Uint8Array): SniffedContainer {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return 'png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes('webm') ? 'webm' : 'matroska';
  }
  if (bytes.length >= 12) {
    const box = ascii(bytes, 4, 8);
    if (box === 'ftyp') return ascii(bytes, 8, 12) === 'qt  ' ? 'mov' : 'mp4';
    if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'mov';
  }
  return 'unknown';
}

/**
 * Server-side filename sanitising: keep a short, safe display name; never used as a key.
 * Strips control characters, characters that are unsafe in download filenames, and
 * bidirectional overrides / zero-width characters that could disguise a name for reviewers
 * (e.g. a right-to-left override, U+202E, can make "photo<U+202E>gpj.exe" display as "photoexe.jpg").
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'upload';
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'upload').slice(0, 120);
}

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** Normalised ffprobe output (packages/media parses raw JSON into this). */
export interface ProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown';
  codec: string | null;
  codecTag: string | null;
  width?: number;
  height?: number;
  pixFmt?: string | null;
  /** Average frame rate, frames per second. */
  avgFrameRate?: number | null;
  realFrameRate?: number | null;
  rotation?: number;
  channels?: number;
  sampleRate?: number;
  durationMs?: number | null;
  startTimeMs?: number | null;
  attachedPic?: boolean;
}

export interface ProbeSummary {
  formatName: string;
  durationMs: number | null;
  startTimeMs: number | null;
  bitRate: number | null;
  streams: ProbeStream[];
  /** Encryption markers detected (encv/enca sample entries, protection boxes). */
  encrypted: boolean;
}

export interface MediaCaps {
  maxVideoDurationMs: number;
  maxVideoDimension: number;
  maxImagePixels: number;
  maxStreams: number;
}

export interface NormalizedMedia {
  kind: MediaKind;
  /** Display dimensions after applying rotation metadata. */
  width: number;
  height: number;
  durationMs: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  frameRate: number | null;
  variableFrameRate: boolean;
  rotation: number;
  pixFmt: string | null;
}

export type ValidationFailureCode =
  | 'malformed_media'
  | 'encrypted_media'
  | 'unsupported_codec'
  | 'no_video_stream'
  | 'no_image_stream'
  | 'too_long'
  | 'dimensions_too_large'
  | 'too_many_streams'
  | 'mime_mismatch'
  | 'unsupported_type'
  | 'size_mismatch'
  | 'too_large';

export type ProbeValidation =
  | { ok: true; media: NormalizedMedia }
  | { ok: false; code: ValidationFailureCode; detail: string };

const FAIL = (code: ValidationFailureCode, detail: string): ProbeValidation => ({ ok: false, code, detail });

export function validateProbe(kind: MediaKind, probe: ProbeSummary, caps: MediaCaps): ProbeValidation {
  if (probe.encrypted) return FAIL('encrypted_media', 'Encrypted or DRM-protected media cannot be processed.');
  if (probe.streams.length === 0) return FAIL('malformed_media', 'No readable streams were found.');
  if (probe.streams.length > caps.maxStreams) {
    return FAIL('too_many_streams', `The file has ${probe.streams.length} streams (limit ${caps.maxStreams}).`);
  }
  const visual = probe.streams.filter((s) => s.type === 'video' && !s.attachedPic);

  if (kind === 'image') {
    const img = visual[0];
    if (!img || !img.width || !img.height) return FAIL('no_image_stream', 'No decodable image was found.');
    if (!img.codec || !(ALLOWED_IMAGE_CODECS as readonly string[]).includes(img.codec)) {
      return FAIL('unsupported_codec', `Image codec "${img.codec ?? 'unknown'}" is not supported.`);
    }
    if (img.width * img.height > caps.maxImagePixels) {
      return FAIL('dimensions_too_large', `${img.width}×${img.height} exceeds the ${caps.maxImagePixels.toLocaleString('en')} pixel limit.`);
    }
    return {
      ok: true,
      media: {
        kind,
        width: img.width,
        height: img.height,
        durationMs: null,
        hasAudio: false,
        videoCodec: img.codec,
        audioCodec: null,
        frameRate: null,
        variableFrameRate: false,
        rotation: 0,
        pixFmt: img.pixFmt ?? null,
      },
    };
  }

  const video = visual[0];
  if (!video || !video.width || !video.height) return FAIL('no_video_stream', 'No video stream was found.');
  if (!video.codec || !(ALLOWED_VIDEO_CODECS as readonly string[]).includes(video.codec)) {
    return FAIL('unsupported_codec', `Video codec "${video.codec ?? 'unknown'}" is not supported.`);
  }
  const audio = probe.streams.find((s) => s.type === 'audio');
  if (audio && (!audio.codec || !(ALLOWED_AUDIO_CODECS as readonly string[]).includes(audio.codec))) {
    return FAIL('unsupported_codec', `Audio codec "${audio.codec ?? 'unknown'}" is not supported.`);
  }
  const durationMs = probe.durationMs ?? video.durationMs ?? null;
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return FAIL('malformed_media', 'The video duration could not be determined.');
  }
  if (durationMs > caps.maxVideoDurationMs) {
    return FAIL('too_long', `The video is longer than the ${Math.round(caps.maxVideoDurationMs / 60000)}-minute limit.`);
  }
  if (Math.max(video.width, video.height) > caps.maxVideoDimension) {
    return FAIL('dimensions_too_large', `${video.width}×${video.height} exceeds the ${caps.maxVideoDimension}px limit.`);
  }
  const rotation = ((((video.rotation ?? 0) % 360) + 360) % 360);
  const swap = rotation === 90 || rotation === 270;
  const avg = video.avgFrameRate ?? null;
  const real = video.realFrameRate ?? null;
  return {
    ok: true,
    media: {
      kind,
      width: swap ? video.height : video.width,
      height: swap ? video.width : video.height,
      durationMs: Math.round(durationMs),
      hasAudio: Boolean(audio),
      videoCodec: video.codec,
      audioCodec: audio?.codec ?? null,
      frameRate: avg,
      variableFrameRate: avg !== null && real !== null && Math.abs(avg - real) > 0.01,
      rotation,
      pixFmt: video.pixFmt ?? null,
    },
  };
}

// ----- Destination format profiles --------------------------------------------------------

export interface DestinationFormatProfile {
  /** Human label of the profile source, e.g. "Simulator profile (not a platform limit)". */
  source: string;
  publishMode: 'api' | 'manual_export';
  video?: {
    minDurationMs: number;
    maxDurationMs: number;
    maxBytes: number;
    /** Allowed width/height ratio range. */
    aspect: { min: number; max: number };
    containers: readonly string[];
  };
  image?: { maxBytes: number; aspect: { min: number; max: number }; mimes: readonly string[] };
  carousel?: { minItems: number; maxItems: number; allowVideo: boolean };
  visibilities: readonly Visibility[];
  captionMaxLength: number;
  title?: { required: boolean; maxLength: number };
}

export interface DestinationMediaItem {
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationMs: number | null;
}

export interface DestinationIssue {
  field: 'media' | 'caption' | 'title' | 'visibility' | 'destination';
  code: string;
  message: string;
}

export function formatOf(items: readonly DestinationMediaItem[]): 'video' | 'image' | 'carousel' | 'none' {
  if (items.length === 0) return 'none';
  if (items.length > 1) return 'carousel';
  return items[0]!.kind;
}

export function validateForDestination(
  profile: DestinationFormatProfile,
  input: { media: readonly DestinationMediaItem[]; caption: string; title: string | null; visibility: Visibility },
): DestinationIssue[] {
  const issues: DestinationIssue[] = [];
  const format = formatOf(input.media);
  const aspectOk = (item: DestinationMediaItem, range: { min: number; max: number }) => {
    const ratio = item.width / item.height;
    return ratio >= range.min - 0.005 && ratio <= range.max + 0.005;
  };

  if (format === 'none') issues.push({ field: 'media', code: 'media_required', message: 'Add a video or image.' });
  if (format === 'carousel') {
    const c = profile.carousel;
    if (!c) {
      issues.push({ field: 'media', code: 'carousel_unsupported', message: 'This destination does not accept carousels.' });
    } else {
      if (input.media.length < c.minItems || input.media.length > c.maxItems) {
        issues.push({ field: 'media', code: 'carousel_size', message: `Carousels need ${c.minItems}–${c.maxItems} items.` });
      }
      if (!c.allowVideo && input.media.some((m) => m.kind === 'video')) {
        issues.push({ field: 'media', code: 'carousel_video_unsupported', message: 'Carousels here can only contain images.' });
      }
    }
  }
  // Every item must satisfy the destination's image/video rules, carousel items included
  // (unless carousels are refused outright, which says all there is to say).
  const items = format === 'carousel' && !profile.carousel ? [] : input.media;
  for (const [index, item] of items.entries()) {
    const label = format === 'carousel' ? `Item ${index + 1}: ` : '';
    const add = (code: string, message: string) => issues.push({ field: 'media', code, message: `${label}${message}` });
    if (item.kind === 'video') {
      // A video in an image-only carousel is already reported above.
      if (format === 'carousel' && profile.carousel && !profile.carousel.allowVideo) continue;
      const v = profile.video;
      if (!v) {
        add('video_unsupported', 'This destination does not accept video.');
        continue;
      }
      if (item.durationMs !== null && (item.durationMs < v.minDurationMs || item.durationMs > v.maxDurationMs)) {
        add('video_duration', `Video must be ${Math.round(v.minDurationMs / 1000)}–${Math.round(v.maxDurationMs / 1000)} s here.`);
      }
      if (item.sizeBytes > v.maxBytes) add('video_too_large', 'Video file is too large for this destination.');
      if (!aspectOk(item, v.aspect)) add('video_aspect', 'Video aspect ratio is not accepted here.');
    } else {
      const i = profile.image;
      if (!i) {
        add('image_unsupported', 'This destination does not accept images.');
        continue;
      }
      if (!i.mimes.includes(item.mime)) add('image_type', `${item.mime} images are not accepted here.`);
      if (item.sizeBytes > i.maxBytes) add('image_too_large', 'Image is too large for this destination.');
      if (!aspectOk(item, i.aspect)) add('image_aspect', 'Image aspect ratio is not accepted here.');
    }
  }
  if ([...input.caption].length > profile.captionMaxLength) {
    issues.push({ field: 'caption', code: 'caption_too_long', message: `Caption must be ${profile.captionMaxLength} characters or fewer.` });
  }
  if (profile.title) {
    const t = input.title?.trim() ?? '';
    if (profile.title.required && t.length === 0) issues.push({ field: 'title', code: 'title_required', message: 'A title is required here.' });
    if ([...t].length > profile.title.maxLength) {
      issues.push({ field: 'title', code: 'title_too_long', message: `Title must be ${profile.title.maxLength} characters or fewer.` });
    }
  }
  if (!profile.visibilities.includes(input.visibility)) {
    issues.push({ field: 'visibility', code: 'visibility_unsupported', message: 'This visibility is not available for this destination.' });
  }
  return issues;
}
