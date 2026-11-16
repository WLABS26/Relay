import { Skeleton } from '@relay/ui';

/** Shown inside the shell while a workspace page loads, so navigation responds immediately. */
export default function WorkspaceLoading() {
  return (
    <div className="r-stack" role="status" aria-live="polite" aria-label="Loading">
      <Skeleton height={32} width="40%" />
      <Skeleton height={120} />
      <Skeleton height={120} />
    </div>
  );
}
