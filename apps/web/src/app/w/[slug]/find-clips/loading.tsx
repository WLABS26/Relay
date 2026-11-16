import { Skeleton } from '@relay/ui';

/** Shown while a Find clips screen loads, so navigation between videos responds at once. */
export default function FindClipsLoading() {
  return (
    <div className="r-stack" role="status" aria-live="polite" aria-label="Loading videos">
      <Skeleton height={32} width="30%" />
      <Skeleton height={16} width="60%" />
      <Skeleton height={104} />
      <Skeleton height={104} />
      <Skeleton height={104} />
    </div>
  );
}
