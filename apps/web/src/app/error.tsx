'use client';

import { Banner, Button } from '@relay/ui';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="app-content">
      <Banner tone="danger" title="Something went wrong">
        Relay could not load this page.{error.digest ? ` Reference: ${error.digest}.` : ''}
      </Banner>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
