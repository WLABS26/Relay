'use client';

import { useState } from 'react';
import { Banner, Badge } from '@relay/ui';
import { apiFetch, errorMessage } from '@/lib/client/api';

export function DemoSignIn({
  users,
  returnTo,
}: {
  users: Array<{ email: string; displayName: string; summary: string }>;
  returnTo: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function signIn(email: string) {
    setBusy(email);
    setError(null);
    try {
      await apiFetch('/api/auth/demo', { body: { email } });
      window.location.assign(returnTo);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }
  return (
    <section className="r-stack" aria-labelledby="demo-heading">
      <Banner tone="info" title="Demo mode">
        These are seeded demo accounts with sample data. Connections are simulated: nothing is
        posted to real platforms.
      </Banner>
      <h3 id="demo-heading" className="r-section-title">
        Choose a demo account
      </h3>
      {users.length === 0 ? (
        <p className="r-muted r-small">
          No demo users yet. Run <code>pnpm db:seed</code>.
        </p>
      ) : null}
      <ul className="r-stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {users.map((u) => (
          <li key={u.email}>
            <button
              type="button"
              className="demo-user"
              onClick={() => signIn(u.email)}
              disabled={busy !== null}
              aria-busy={busy === u.email}
            >
              <span className="r-stack-sm" style={{ gap: 2 }}>
                <span className="r-strong">{u.displayName}</span>
                <span className="r-xs r-muted">{u.summary}</span>
              </span>
              <Badge tone="sim">Demo</Badge>
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <Banner tone="danger" live>
          {error}
        </Banner>
      ) : null}
    </section>
  );
}
