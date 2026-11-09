'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, describedBy, Field } from '@relay/ui';
import { ApiError, apiFetch, errorMessage } from '@/lib/client/api';

export function CreateWorkspace() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
  );
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="r-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setErrors({});
        try {
          const ws = await apiFetch<{ slug: string }>('/api/v1/workspaces', {
            body: { name, slug, timezone },
          });
          router.push(`/w/${ws.slug}/settings/pages`);
        } catch (err) {
          if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors);
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <Field id="ws-name" label="Workspace name" error={errors.name?.[0]}>
        <input
          id="ws-name"
          className="r-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slug) setSlug('');
          }}
          required
          maxLength={80}
          aria-invalid={Boolean(errors.name)}
        />
      </Field>
      <Field
        id="ws-slug"
        label="Address"
        hint="Used in URLs: /w/your-address. Lowercase letters, numbers and hyphens."
        error={errors.slug?.[0]}
      >
        <input
          id="ws-slug"
          className="r-input"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          required
          pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
          aria-describedby={describedBy('ws-slug', { hint: true, error: errors.slug })}
          aria-invalid={Boolean(errors.slug)}
        />
      </Field>
      <Field
        id="ws-tz"
        label="Default time zone"
        hint="IANA zone such as Europe/Berlin."
        error={errors.timezone?.[0]}
      >
        <input
          id="ws-tz"
          className="r-input"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          required
          aria-describedby={describedBy('ws-tz', { hint: true, error: errors.timezone })}
        />
      </Field>
      {error ? (
        <Banner tone="danger" live>
          {error}
        </Banner>
      ) : null}
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Create workspace
        </Button>
      </div>
    </form>
  );
}
