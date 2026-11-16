import { Skeleton } from '@relay/ui';

/** Shown while the clip editor loads: the same two-column shape, so nothing jumps. */
export default function ClipLoading() {
  return (
    <div className="r-stack" role="status" aria-live="polite" aria-label="Loading the clip">
      <Skeleton height={32} width="40%" />
      <div className="clip-editor">
        <Skeleton height={420} />
        <div className="r-stack">
          <Skeleton height={180} />
          <Skeleton height={140} />
          <Skeleton height={140} />
        </div>
      </div>
    </div>
  );
}
