import Link from 'next/link';
import { EmptyState, linkButtonClass } from '@relay/ui';

export default function NotFound() {
  return (
    <main id="main" className="app-content">
      <EmptyState
        title="Not found"
        action={
          <Link className={linkButtonClass('secondary')} href="/">
            Go to Relay
          </Link>
        }
      >
        This page does not exist, or you do not have access to it.
      </EmptyState>
    </main>
  );
}
