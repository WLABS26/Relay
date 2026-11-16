/**
 * Clip editing primitives shared by the web preview, the services and the renderer. Everything
 * here is pure: the browser and the worker must agree on what a range and a crop mean, so both
 * call these functions rather than re-deriving the numbers (spec 6.5).
 *
 * Timeline convention: milliseconds on a 0-based media timeline (first video frame = 0);
 * `startMs` is inclusive and `endMs` exclusive.
 */

export const CLIP_PROFILE = 'mp4-h264-aac';
export type ClipProfile = typeof CLIP_PROFILE;

/** Every render is constant frame rate at this value, whatever the source rate was. */
export const CLIP_FPS = 30;

export const CLIP_ASPECTS = ['9:16', '1:1', 'original'] as const;
export type ClipAspect = (typeof CLIP_ASPECTS)[number];

export const CLIP_CROP_MODES = ['fit', 'fill'] as const;
export type ClipCropMode = (typeof CLIP_CROP_MODES)[number];

export const CLIP_CAPTION_STYLES = ['default'] as const;
export type ClipCaptionStyle = (typeof CLIP_CAPTION_STYLES)[number];

export const CANDIDATE_FEEDBACK = [
  'accepted',
  'trim_adjusted',
  'missing_context',
  'wrong_fit',
  'rights_issue',
] as const;
export type CandidateFeedback = (typeof CANDIDATE_FEEDBACK)[number];

/** Shortest range the editor accepts; the upper bound is deployment configuration. */
export const CLIP_MIN_MS = 1000;

// ----- Range --------------------------------------------------------------------------

export interface ClipRangeInput {
  startMs: number;
  endMs: number;
  sourceDurationMs: number;
  minMs: number;
  maxMs: number;
}

export type ClipRangeValidation =
  { ok: true; durationMs: number } | { ok: false; fieldErrors: Record<string, string[]> };

const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))} s`;

/**
 * Checks a range against its source. Errors are keyed by the request field they belong to so
 * the editor can show them beside the in or out control.
 */
export function validateClipRange(input: ClipRangeInput): ClipRangeValidation {
  const { startMs, endMs, sourceDurationMs, minMs, maxMs } = input;
  // The limits come from our own records and configuration, not from the request. A missing
  // duration (NaN, null cast to a number) would make every comparison below false and accept
  // any range, so it is refused outright instead of being reported as a field error.
  if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs < 0) {
    throw new RangeError('validateClipRange needs the source duration in whole milliseconds');
  }
  if (!Number.isSafeInteger(minMs) || !Number.isSafeInteger(maxMs) || minMs < 1 || maxMs < minMs) {
    throw new RangeError('validateClipRange needs integer limits with 1 <= minMs <= maxMs');
  }

  const fieldErrors: Record<string, string[]> = {};
  const add = (field: 'startMs' | 'endMs', message: string): void => {
    (fieldErrors[field] ??= []).push(message);
  };

  const startValid = Number.isSafeInteger(startMs) && startMs >= 0;
  const endValid = Number.isSafeInteger(endMs) && endMs >= 0;
  if (!startValid) add('startMs', 'The start must be a whole number of milliseconds, 0 or later');
  if (!endValid) add('endMs', 'The end must be a whole number of milliseconds, 0 or later');

  if (startValid && endValid) {
    if (endMs <= startMs) {
      add('endMs', 'The end must be after the start');
    } else {
      // Compare against the duration only once the order is right, so one mistake yields one
      // message rather than three.
      if (startMs >= sourceDurationMs) add('startMs', 'The start is past the end of the source');
      if (endMs > sourceDurationMs) add('endMs', 'The end is past the end of the source');
      const length = endMs - startMs;
      if (length < minMs) add('endMs', `A clip must be at least ${seconds(minMs)} long`);
      if (length > maxMs) add('endMs', `A clip can be at most ${seconds(maxMs)} long`);
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, durationMs: endMs - startMs };
}

/**
 * The single definition of how many frames a range yields. Output frame k of the constant-rate
 * timeline sits at k / fps seconds and belongs to the clip when that instant lies in
 * [startMs, endMs). Counting on the grid (rather than rounding the length) keeps adjacent
 * ranges from sharing or dropping a frame, and the result never exceeds what an encoder
 * produces for the same length, so it is safe as a hard `-frames:v` bound.
 */
export function clipFrameCount(startMs: number, endMs: number, fps: number = CLIP_FPS): number {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0) {
    throw new RangeError('clipFrameCount needs non-negative integer milliseconds');
  }
  if (endMs <= startMs) throw new RangeError('clipFrameCount needs endMs after startMs');
  if (!Number.isSafeInteger(fps) || fps <= 0) {
    throw new RangeError('clipFrameCount needs a positive integer frame rate');
  }
  const firstFrame = Math.ceil((startMs * fps) / 1000);
  const endFrame = Math.ceil((endMs * fps) / 1000);
  // A range shorter than one frame interval can fall between two grid points; a render still
  // has to contain a picture.
  return Math.max(1, endFrame - firstFrame);
}

// ----- Geometry -----------------------------------------------------------------------

export interface ClipGeometryInput {
  /** Display dimensions (after rotation), as in `NormalizedMedia`. */
  sourceWidth: number;
  sourceHeight: number;
  aspect: ClipAspect;
  cropMode: ClipCropMode;
}

/**
 * Numbers for `scale` then `crop` (fill) or `pad` (fit). All values are even because the
 * output is 4:2:0; the crop and pad offsets may be 0.
 */
export interface ClipGeometry {
  outWidth: number;
  outHeight: number;
  /** Size the source is scaled to before cropping or padding. */
  scaleWidth: number;
  scaleHeight: number;
  /** Top-left of the output window inside the scaled picture (fill). */
  cropX: number;
  cropY: number;
  /** Top-left of the scaled picture inside the output frame (fit). */
  padX: number;
  padY: number;
}

const CLIP_TARGETS: Record<Exclude<ClipAspect, 'original'>, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

const evenFloor = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);
const evenCeil = (n: number): number => Math.max(2, Math.ceil(n / 2) * 2);
/** Half of the spare space, rounded down to even so chroma stays aligned. */
const evenOffset = (spare: number): number => Math.max(0, Math.floor(spare / 4) * 2);

export function clipGeometry(input: ClipGeometryInput): ClipGeometry {
  const { sourceWidth: sw, sourceHeight: sh, aspect, cropMode } = input;
  if (!Number.isSafeInteger(sw) || !Number.isSafeInteger(sh) || sw < 2 || sh < 2) {
    throw new RangeError('clipGeometry needs integer source dimensions of at least 2x2');
  }

  if (aspect === 'original') {
    // An odd edge loses at most one pixel to the scale; nothing is cropped or padded, so the
    // crop mode has no effect here.
    const outWidth = evenFloor(sw);
    const outHeight = evenFloor(sh);
    return {
      outWidth,
      outHeight,
      scaleWidth: outWidth,
      scaleHeight: outHeight,
      cropX: 0,
      cropY: 0,
      padX: 0,
      padY: 0,
    };
  }

  const target = CLIP_TARGETS[aspect];
  let outWidth = target.width;
  let outHeight = target.height;

  // No upscaling of small sources: when the source's short side cannot fill the target's, the
  // target shrinks (same aspect) until the source fits at its native scale. Sources that do
  // reach the target's short side always produce the full-size target, so a 1080p landscape
  // video still yields a 1080x1920 vertical clip.
  if (Math.min(sw, sh) < Math.min(target.width, target.height)) {
    // Integer cross-products decide which edge drives the scale; dividing first would let a
    // rounding error turn 720 into 719.99 and cost two pixels.
    const widthDrives =
      cropMode === 'fill'
        ? target.width * sh >= target.height * sw
        : target.width * sh <= target.height * sw;
    const needsUpscale = widthDrives ? target.width > sw : target.height > sh;
    if (needsUpscale) {
      if (widthDrives) {
        outWidth = evenFloor(sw);
        outHeight = evenFloor((target.height * sw) / target.width);
      } else {
        outHeight = evenFloor(sh);
        outWidth = evenFloor((target.width * sh) / target.height);
      }
    }
  }

  if (cropMode === 'fill') {
    // Cover: the edge with the larger ratio matches the output exactly, the other overflows
    // and is centre-cropped.
    let scaleWidth: number;
    let scaleHeight: number;
    if (outWidth * sh >= outHeight * sw) {
      scaleWidth = outWidth;
      scaleHeight = Math.max(outHeight, evenCeil((sh * outWidth) / sw));
    } else {
      scaleHeight = outHeight;
      scaleWidth = Math.max(outWidth, evenCeil((sw * outHeight) / sh));
    }
    return {
      outWidth,
      outHeight,
      scaleWidth,
      scaleHeight,
      cropX: evenOffset(scaleWidth - outWidth),
      cropY: evenOffset(scaleHeight - outHeight),
      padX: 0,
      padY: 0,
    };
  }

  // Contain: the edge with the smaller ratio matches the output exactly, the other is padded.
  let scaleWidth: number;
  let scaleHeight: number;
  if (outWidth * sh <= outHeight * sw) {
    scaleWidth = outWidth;
    scaleHeight = Math.min(outHeight, evenFloor((sh * outWidth) / sw));
  } else {
    scaleHeight = outHeight;
    scaleWidth = Math.min(outWidth, evenFloor((sw * outHeight) / sh));
  }
  return {
    outWidth,
    outHeight,
    scaleWidth,
    scaleHeight,
    cropX: 0,
    cropY: 0,
    padX: evenOffset(outWidth - scaleWidth),
    padY: evenOffset(outHeight - scaleHeight),
  };
}

// ----- Hash inputs --------------------------------------------------------------------

/** One caption cue on the source timeline, as stored in `clip_revisions.captions`. */
export interface ClipCaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * The parts of a revision that change the rendered picture or sound. The title is left out on
 * purpose: renaming a clip must not force a new render.
 */
export interface ClipEdit {
  startMs: number;
  endMs: number;
  aspect: ClipAspect;
  cropMode: ClipCropMode;
  captions: readonly ClipCaptionCue[] | null;
  captionStyle: ClipCaptionStyle;
}

export interface RenderKeyInput {
  editHash: string;
  profile: ClipProfile;
  sourceAssetId: string;
  sourceAssetVersion: number;
  /** Content hash of the source, so a re-uploaded object can never reuse an old render. */
  sourceSha256: string;
  rendererVersion: string;
}
