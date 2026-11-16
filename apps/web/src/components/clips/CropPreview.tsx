'use client';

import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { ClipGeometry } from '@relay/domain';

/**
 * The output frame, drawn from the numbers `clipGeometry` returns, which are the numbers the
 * renderer scales, crops and pads with. The frame has the output's shape; the source picture is
 * placed inside it at the scaled size and the crop or pad offset, all as fractions of the
 * output, so what is visible here is what the render keeps.
 */
export function CropPreview({
  geometry,
  videoRef,
  src,
  label,
  caption,
  onVideoError,
  children,
}: {
  geometry: ClipGeometry;
  videoRef: RefObject<HTMLVideoElement | null>;
  src: string | null;
  label: string;
  /** The cue on screen at the playhead, if any. */
  caption: string | null;
  onVideoError: () => void;
  children?: ReactNode;
}) {
  const { outWidth, outHeight, scaleWidth, scaleHeight, cropX, cropY, padX, padY } = geometry;
  const frame = { '--clip-ar': String(outWidth / outHeight) } as CSSProperties;
  const picture: CSSProperties = {
    width: `${(scaleWidth / outWidth) * 100}%`,
    height: `${(scaleHeight / outHeight) * 100}%`,
    left: `${((padX - cropX) / outWidth) * 100}%`,
    top: `${((padY - cropY) / outHeight) * 100}%`,
  };
  return (
    <div className="crop-stage" style={frame}>
      <video
        ref={videoRef}
        className="crop-stage__video"
        style={picture}
        src={src ?? undefined}
        playsInline
        preload="auto"
        aria-label={label}
        onError={onVideoError}
      />
      {caption ? (
        <p className="crop-stage__caption" aria-hidden>
          {caption}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** What the chosen shape does to the picture, in words. */
export function describeGeometry(geometry: ClipGeometry): string {
  const { outWidth, outHeight, scaleWidth, scaleHeight, cropX, cropY, padX, padY } = geometry;
  const size = `${outWidth}×${outHeight}`;
  const cutSides = Math.round((1 - outWidth / scaleWidth) * 100);
  const cutHeight = Math.round((1 - outHeight / scaleHeight) * 100);
  if (cropX > 0 && cutSides > 0)
    return `Output ${size}. ${cutSides}% of the width is cropped, evenly from both sides.`;
  if (cropY > 0 && cutHeight > 0)
    return `Output ${size}. ${cutHeight}% of the height is cropped, evenly from top and bottom.`;
  if (padX > 0) return `Output ${size}. The whole picture is kept, with bars left and right.`;
  if (padY > 0) return `Output ${size}. The whole picture is kept, with bars above and below.`;
  return `Output ${size}. The whole picture is kept.`;
}
