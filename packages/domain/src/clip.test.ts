import { describe, expect, it } from 'vitest';
import {
  CLIP_ASPECTS,
  CLIP_CROP_MODES,
  CLIP_FPS,
  CLIP_PROFILE,
  clipFrameCount,
  clipGeometry,
  validateClipRange,
  type ClipEdit,
  type ClipGeometry,
  type RenderKeyInput,
} from './clip';
import {
  candidateFeedbackSchema,
  createClipSchema,
  importCaptionsSchema,
  requestRenderSchema,
  startAnalysisSchema,
  updateClipSchema,
} from './schemas';
import { clipEditHash, renderKey } from './server';

const LIMITS = { sourceDurationMs: 60_000, minMs: 1000, maxMs: 30_000 };
const ID_A = '018f3b2e-7c1a-7000-8000-000000000001';
const ID_B = '018f3b2e-7c1a-7000-8000-000000000002';

describe('validateClipRange', () => {
  it('accepts a range inside the source, up to and including its last millisecond', () => {
    expect(validateClipRange({ startMs: 0, endMs: 15_000, ...LIMITS })).toEqual({
      ok: true,
      durationMs: 15_000,
    });
    expect(validateClipRange({ startMs: 45_000, endMs: 60_000, ...LIMITS }).ok).toBe(true);
  });

  it.each([
    ['equal', 5000, 5000],
    ['reversed', 5000, 4000],
  ])('rejects an end that is not after the start (%s)', (_name, startMs, endMs) => {
    const result = validateClipRange({ startMs, endMs, ...LIMITS });
    expect(result).toEqual({
      ok: false,
      fieldErrors: { endMs: ['The end must be after the start'] },
    });
  });

  it('rejects negative and fractional values on the field they belong to', () => {
    const negative = validateClipRange({ startMs: -1, endMs: 5000, ...LIMITS });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(Object.keys(negative.fieldErrors)).toEqual(['startMs']);

    const fractional = validateClipRange({ startMs: 0, endMs: 5000.5, ...LIMITS });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(Object.keys(fractional.fieldErrors)).toEqual(['endMs']);

    expect(validateClipRange({ startMs: Number.NaN, endMs: -3, ...LIMITS })).toMatchObject({
      ok: false,
      fieldErrors: { startMs: [expect.any(String)], endMs: [expect.any(String)] },
    });
  });

  it('rejects ranges past the duration', () => {
    const end = validateClipRange({ startMs: 50_000, endMs: 60_001, ...LIMITS });
    expect(end).toEqual({
      ok: false,
      fieldErrors: { endMs: ['The end is past the end of the source'] },
    });
    const both = validateClipRange({ startMs: 60_000, endMs: 62_000, ...LIMITS });
    expect(both).toMatchObject({
      ok: false,
      fieldErrors: { startMs: [expect.any(String)], endMs: [expect.any(String)] },
    });
  });

  it('refuses an unknown duration or broken limits instead of accepting every range', () => {
    const range = { startMs: 0, endMs: 5000 };
    for (const limits of [
      { ...LIMITS, sourceDurationMs: Number.NaN },
      { ...LIMITS, sourceDurationMs: null as unknown as number },
      { ...LIMITS, sourceDurationMs: 59_999.5 },
      { ...LIMITS, maxMs: Number.NaN },
      { ...LIMITS, minMs: 0 },
      { ...LIMITS, minMs: 2000, maxMs: 1000 },
    ]) {
      expect(() => validateClipRange({ ...range, ...limits })).toThrow(RangeError);
    }
  });

  it('enforces the length limits inclusively', () => {
    expect(validateClipRange({ startMs: 0, endMs: 1000, ...LIMITS }).ok).toBe(true);
    expect(validateClipRange({ startMs: 0, endMs: 30_000, ...LIMITS }).ok).toBe(true);
    expect(validateClipRange({ startMs: 0, endMs: 999, ...LIMITS })).toEqual({
      ok: false,
      fieldErrors: { endMs: ['A clip must be at least 1 s long'] },
    });
    expect(validateClipRange({ startMs: 0, endMs: 30_001, ...LIMITS })).toEqual({
      ok: false,
      fieldErrors: { endMs: ['A clip can be at most 30 s long'] },
    });
  });
});

describe('clipFrameCount', () => {
  it('yields 60 frames for two seconds at the default rate', () => {
    expect(CLIP_FPS).toBe(30);
    expect(clipFrameCount(1000, 3000)).toBe(60);
  });

  it('treats endMs as exclusive and counts frames on the output grid', () => {
    expect(clipFrameCount(2000, 5000)).toBe(90);
    // 2333 ms falls just before frame 70, so the clip holds frames 70..149.
    expect(clipFrameCount(2333, 5000)).toBe(80);
    expect(clipFrameCount(0, 1000, 25)).toBe(25);
  });

  it('splits a range into parts without gaining or losing a frame', () => {
    for (const cut of [1, 33, 34, 1000, 2333, 4966]) {
      expect(clipFrameCount(0, cut) + clipFrameCount(cut, 5000)).toBe(clipFrameCount(0, 5000));
    }
  });

  it('never returns zero and never exceeds what the length alone allows', () => {
    expect(clipFrameCount(1, 2)).toBe(1);
    for (const [start, end] of [
      [0, 1000],
      [17, 1017],
      [2333, 5000],
      [999, 60_000],
    ] as const) {
      const count = clipFrameCount(start, end);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(Math.ceil(((end - start) * CLIP_FPS) / 1000));
    }
  });

  it('refuses empty, reversed and non-integer input', () => {
    expect(() => clipFrameCount(1000, 1000)).toThrow(RangeError);
    expect(() => clipFrameCount(3000, 1000)).toThrow(RangeError);
    expect(() => clipFrameCount(-1, 1000)).toThrow(RangeError);
    expect(() => clipFrameCount(0.5, 1000)).toThrow(RangeError);
    expect(() => clipFrameCount(0, 1000, 0)).toThrow(RangeError);
  });
});

describe('clipGeometry', () => {
  it('fills 9:16 from 1920x1080 with a centred crop', () => {
    expect(
      clipGeometry({ sourceWidth: 1920, sourceHeight: 1080, aspect: '9:16', cropMode: 'fill' }),
    ).toEqual<ClipGeometry>({
      outWidth: 1080,
      outHeight: 1920,
      scaleWidth: 3414,
      scaleHeight: 1920,
      cropX: 1166,
      cropY: 0,
      padX: 0,
      padY: 0,
    });
  });

  it('fills 9:16 from 1280x720 as 404x720: even, and not upscaled', () => {
    expect(
      clipGeometry({ sourceWidth: 1280, sourceHeight: 720, aspect: '9:16', cropMode: 'fill' }),
    ).toEqual<ClipGeometry>({
      outWidth: 404,
      outHeight: 720,
      scaleWidth: 1280,
      scaleHeight: 720,
      cropX: 438,
      cropY: 0,
      padX: 0,
      padY: 0,
    });
  });

  it.each(CLIP_CROP_MODES)('rounds an odd original down to even (%s)', (cropMode) => {
    expect(
      clipGeometry({ sourceWidth: 721, sourceHeight: 1279, aspect: 'original', cropMode }),
    ).toEqual<ClipGeometry>({
      outWidth: 720,
      outHeight: 1278,
      scaleWidth: 720,
      scaleHeight: 1278,
      cropX: 0,
      cropY: 0,
      padX: 0,
      padY: 0,
    });
  });

  it('fits a 720x720 square into 9:16 by padding top and bottom, without upscaling', () => {
    expect(
      clipGeometry({ sourceWidth: 720, sourceHeight: 720, aspect: '9:16', cropMode: 'fit' }),
    ).toEqual<ClipGeometry>({
      outWidth: 720,
      outHeight: 1280,
      scaleWidth: 720,
      scaleHeight: 720,
      cropX: 0,
      cropY: 0,
      padX: 0,
      padY: 280,
    });
  });

  it('fits landscape 1080p into 9:16 with bars above and below', () => {
    expect(
      clipGeometry({ sourceWidth: 1920, sourceHeight: 1080, aspect: '9:16', cropMode: 'fit' }),
    ).toMatchObject({
      outWidth: 1080,
      outHeight: 1920,
      scaleWidth: 1080,
      scaleHeight: 606,
      padX: 0,
      padY: 656,
    });
  });

  it('uses display dimensions for a rotated source', () => {
    // Stored as 1920x1080 with a 90 degree rotation tag: NormalizedMedia reports 1080x1920, and
    // that is what the caller passes. The clip is then already 9:16 and needs no crop.
    const display = { width: 1080, height: 1920, rotation: 90 };
    expect(
      clipGeometry({
        sourceWidth: display.width,
        sourceHeight: display.height,
        aspect: '9:16',
        cropMode: 'fill',
      }),
    ).toEqual<ClipGeometry>({
      outWidth: 1080,
      outHeight: 1920,
      scaleWidth: 1080,
      scaleHeight: 1920,
      cropX: 0,
      cropY: 0,
      padX: 0,
      padY: 0,
    });
    // Passing the coded dimensions instead would crop a landscape picture, which is the bug
    // this convention prevents.
    expect(
      clipGeometry({ sourceWidth: 1920, sourceHeight: 1080, aspect: '9:16', cropMode: 'fill' })
        .cropX,
    ).toBeGreaterThan(0);
  });

  it('crops a square from the centre for 1:1, downscaling a large source', () => {
    expect(
      clipGeometry({ sourceWidth: 3840, sourceHeight: 2160, aspect: '1:1', cropMode: 'fill' }),
    ).toMatchObject({ outWidth: 1080, outHeight: 1080, scaleWidth: 1920, scaleHeight: 1080 });
    expect(
      clipGeometry({ sourceWidth: 640, sourceHeight: 360, aspect: '1:1', cropMode: 'fill' }),
    ).toMatchObject({ outWidth: 360, outHeight: 360, scaleWidth: 640, scaleHeight: 360 });
  });

  it('keeps every output even, positive and inside its frame', () => {
    const sizes = [2, 3, 17, 240, 359, 360, 479, 721, 1079, 1080, 1279, 1921, 2160, 4096];
    for (const sourceWidth of sizes) {
      for (const sourceHeight of sizes) {
        for (const aspect of CLIP_ASPECTS) {
          for (const cropMode of CLIP_CROP_MODES) {
            const g = clipGeometry({ sourceWidth, sourceHeight, aspect, cropMode });
            const label = `${sourceWidth}x${sourceHeight} ${aspect} ${cropMode}`;
            for (const [name, value] of Object.entries(g)) {
              expect(Number.isInteger(value) && value % 2 === 0, `${label} ${name} even`).toBe(
                true,
              );
            }
            for (const value of [g.outWidth, g.outHeight, g.scaleWidth, g.scaleHeight]) {
              expect(value, `${label} positive`).toBeGreaterThan(0);
            }
            for (const value of [g.cropX, g.cropY, g.padX, g.padY]) {
              expect(value, `${label} offset`).toBeGreaterThanOrEqual(0);
            }
            // The crop window lies inside the scaled picture, and the scaled picture inside
            // the padded frame; FFmpeg rejects the filter otherwise.
            if (cropMode === 'fill' || aspect === 'original') {
              expect(g.cropX + g.outWidth, label).toBeLessThanOrEqual(g.scaleWidth);
              expect(g.cropY + g.outHeight, label).toBeLessThanOrEqual(g.scaleHeight);
            }
            if (cropMode === 'fit') {
              expect(g.padX + g.scaleWidth, label).toBeLessThanOrEqual(g.outWidth);
              expect(g.padY + g.scaleHeight, label).toBeLessThanOrEqual(g.outHeight);
            }
            expect(g.outWidth, label).toBeLessThanOrEqual(Math.max(1080, sourceWidth));
            expect(g.outHeight, label).toBeLessThanOrEqual(Math.max(1920, sourceHeight));
          }
        }
      }
    }
  });

  it('never upscales a source whose short side is below the target', () => {
    for (const [sourceWidth, sourceHeight] of [
      [1280, 720],
      [720, 1280],
      [640, 480],
      [479, 853],
      [1079, 4000],
    ] as const) {
      for (const aspect of ['9:16', '1:1'] as const) {
        for (const cropMode of CLIP_CROP_MODES) {
          const g = clipGeometry({ sourceWidth, sourceHeight, aspect, cropMode });
          const label = `${sourceWidth}x${sourceHeight} ${aspect} ${cropMode}`;
          // Rounding to even may add at most one pixel.
          expect(g.scaleWidth, label).toBeLessThanOrEqual(sourceWidth + 1);
          expect(g.scaleHeight, label).toBeLessThanOrEqual(sourceHeight + 1);
        }
      }
    }
  });

  it('refuses dimensions it cannot make even and positive', () => {
    for (const [sourceWidth, sourceHeight] of [
      [0, 100],
      [100, 1],
      [-4, 100],
      [100.5, 100],
      [Number.NaN, 100],
    ] as const) {
      expect(() =>
        clipGeometry({ sourceWidth, sourceHeight, aspect: '9:16', cropMode: 'fill' }),
      ).toThrow(RangeError);
    }
  });
});

const EDIT: ClipEdit = {
  startMs: 2000,
  endMs: 5000,
  aspect: '9:16',
  cropMode: 'fill',
  captions: [{ startMs: 2500, endMs: 3500, text: 'Hello' }],
  captionStyle: 'default',
};

describe('clipEditHash', () => {
  it('is a sha256 hex digest that ignores key order and unrelated properties', () => {
    const hash = clipEditHash(EDIT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      id: ID_A,
      title: 'Renamed',
      captionStyle: EDIT.captionStyle,
      captions: [{ text: 'Hello', endMs: 3500, startMs: 2500 }],
      cropMode: EDIT.cropMode,
      aspect: EDIT.aspect,
      endMs: EDIT.endMs,
      startMs: EDIT.startMs,
    };
    expect(clipEditHash(reordered)).toBe(hash);
  });

  it('changes with every render-relevant field', () => {
    const base = clipEditHash(EDIT);
    const variants: ClipEdit[] = [
      { ...EDIT, startMs: 2001 },
      { ...EDIT, endMs: 5001 },
      { ...EDIT, aspect: '1:1' },
      { ...EDIT, cropMode: 'fit' },
      { ...EDIT, captions: null },
      { ...EDIT, captions: [{ startMs: 2500, endMs: 3500, text: 'Hello!' }] },
      { ...EDIT, captions: [{ startMs: 2500, endMs: 3501, text: 'Hello' }] },
    ];
    const hashes = variants.map(clipEditHash);
    expect(new Set([base, ...hashes]).size).toBe(variants.length + 1);
  });

  it('treats an empty caption list as no captions, and CRLF as LF', () => {
    expect(clipEditHash({ ...EDIT, captions: [] })).toBe(clipEditHash({ ...EDIT, captions: null }));
    const cue = { startMs: 2500, endMs: 3500 };
    expect(clipEditHash({ ...EDIT, captions: [{ ...cue, text: 'one\r\ntwo' }] })).toBe(
      clipEditHash({ ...EDIT, captions: [{ ...cue, text: 'one\ntwo' }] }),
    );
  });
});

describe('renderKey', () => {
  const input: RenderKeyInput = {
    editHash: clipEditHash(EDIT),
    profile: CLIP_PROFILE,
    sourceAssetId: ID_A,
    sourceAssetVersion: 1,
    sourceSha256: 'a'.repeat(64),
    rendererVersion: 'relay-clip@1 ffmpeg 6.1.1',
  };

  it('is stable under key reordering', () => {
    const key = renderKey(input);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const reordered: RenderKeyInput = {
      rendererVersion: input.rendererVersion,
      sourceSha256: input.sourceSha256,
      sourceAssetVersion: input.sourceAssetVersion,
      sourceAssetId: input.sourceAssetId,
      profile: input.profile,
      editHash: input.editHash,
    };
    expect(renderKey(reordered)).toBe(key);
    expect(renderKey({ ...input })).toBe(key);
  });

  it('changes when any input changes', () => {
    const changed: RenderKeyInput[] = [
      { ...input, editHash: clipEditHash({ ...EDIT, endMs: 5001 }) },
      // The profile union has one member today; the key must still depend on it.
      { ...input, profile: 'mp4-h265-aac' as RenderKeyInput['profile'] },
      { ...input, sourceAssetId: ID_B },
      { ...input, sourceAssetVersion: 2 },
      { ...input, sourceSha256: 'b'.repeat(64) },
      { ...input, rendererVersion: 'relay-clip@2 ffmpeg 6.1.1' },
    ];
    const keys = changed.map(renderKey);
    expect(new Set([renderKey(input), ...keys]).size).toBe(changed.length + 1);
  });
});

describe('clip request schemas', () => {
  const update = {
    version: 1,
    startMs: 2000,
    endMs: 5000,
    aspect: '9:16',
    cropMode: 'fill',
    captions: null,
  };

  it('creates a clip from a candidate or from a range, but not both or neither', () => {
    expect(createClipSchema.safeParse({ sourceAssetId: ID_A, candidateId: ID_B }).success).toBe(
      true,
    );
    expect(
      createClipSchema.safeParse({ sourceAssetId: ID_A, startMs: 0, endMs: 15_000, title: ' Cut ' })
        .data,
    ).toEqual({ sourceAssetId: ID_A, startMs: 0, endMs: 15_000, title: 'Cut' });

    const both = createClipSchema.safeParse({
      sourceAssetId: ID_A,
      candidateId: ID_B,
      startMs: 0,
      endMs: 15_000,
    });
    expect(both.error?.issues.map((i) => i.path.join('.'))).toEqual(['candidateId']);

    const neither = createClipSchema.safeParse({ sourceAssetId: ID_A });
    expect(neither.error?.issues.map((i) => i.path.join('.'))).toEqual(['startMs', 'endMs']);

    const half = createClipSchema.safeParse({ sourceAssetId: ID_A, startMs: 0 });
    expect(half.error?.issues.map((i) => i.path.join('.'))).toEqual(['endMs']);

    const reversed = createClipSchema.safeParse({ sourceAssetId: ID_A, startMs: 9, endMs: 9 });
    expect(reversed.error?.issues.map((i) => i.path.join('.'))).toEqual(['endMs']);
  });

  it('rejects unknown keys and non-integer times', () => {
    expect(
      createClipSchema.safeParse({ sourceAssetId: ID_A, candidateId: ID_B, pageId: ID_A }).success,
    ).toBe(false);
    expect(
      createClipSchema.safeParse({ sourceAssetId: ID_A, startMs: 0.5, endMs: 15_000 }).success,
    ).toBe(false);
    expect(updateClipSchema.safeParse({ ...update, startMs: -1 }).success).toBe(false);
    expect(updateClipSchema.safeParse({ ...update, extra: true }).success).toBe(false);
  });

  it('updates a clip with the whole editable state', () => {
    expect(updateClipSchema.safeParse(update).success).toBe(true);
    expect(
      updateClipSchema.safeParse({
        ...update,
        aspect: 'original',
        cropMode: 'fit',
        title: 'Final',
        captions: [{ startMs: 2100, endMs: 2900, text: 'Line one\nLine two' }],
      }).success,
    ).toBe(true);

    const { version: _version, ...withoutVersion } = update;
    expect(updateClipSchema.safeParse(withoutVersion).success).toBe(false);
    expect(updateClipSchema.safeParse({ ...update, aspect: '16:9' }).success).toBe(false);
    expect(updateClipSchema.safeParse({ ...update, cropMode: 'stretch' }).success).toBe(false);
    expect(updateClipSchema.safeParse({ ...update, title: 'x'.repeat(121) }).success).toBe(false);

    const reversed = updateClipSchema.safeParse({ ...update, endMs: 2000 });
    expect(reversed.error?.issues.map((i) => i.path.join('.'))).toEqual(['endMs']);
  });

  it('bounds captions and addresses a malformed cue by index', () => {
    const cue = { startMs: 2100, endMs: 2900, text: 'Hi' };
    const tooMany = Array.from({ length: 501 }, () => cue);
    expect(updateClipSchema.safeParse({ ...update, captions: tooMany }).success).toBe(false);

    const bad = updateClipSchema.safeParse({
      ...update,
      captions: [cue, { ...cue, text: '' }, { ...cue, style: 'big' }],
    });
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toEqual([
      'captions.1.text',
      'captions.2',
    ]);
  });

  it('validates the small command bodies', () => {
    expect(startAnalysisSchema.safeParse({ assetId: ID_A }).success).toBe(true);
    expect(startAnalysisSchema.safeParse({ assetId: 'nope' }).success).toBe(false);

    expect(requestRenderSchema.safeParse({}).success).toBe(true);
    expect(requestRenderSchema.safeParse({ revisionId: ID_A }).success).toBe(true);
    expect(requestRenderSchema.safeParse({ revisionId: 7 }).success).toBe(false);

    expect(candidateFeedbackSchema.safeParse({ feedback: 'wrong_fit' }).success).toBe(true);
    expect(candidateFeedbackSchema.safeParse({ feedback: 'great' }).success).toBe(false);

    expect(importCaptionsSchema.parse({ format: 'srt', text: '1\n' })).toEqual({
      format: 'srt',
      text: '1\n',
      relativeTo: 'clip',
    });
    expect(importCaptionsSchema.safeParse({ format: 'ass', text: 'x' }).success).toBe(false);
  });
});
