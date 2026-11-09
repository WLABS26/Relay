'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { PAGE_GOAL_LABELS, PAGE_GOALS, VISIBILITIES, VISIBILITY_LABELS } from '@relay/domain';
import { Banner, Button, Field } from '@relay/ui';
import { useToast } from '@relay/ui/client';
import { ApiError, apiFetch, errorMessage } from '@/lib/client/api';

export function CreatePageForm({
  workspaceId,
  defaultTimezone,
}: {
  workspaceId: string;
  defaultTimezone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [weekStart, setWeekStart] = useState<'monday' | 'sunday'>('monday');
  const [goal, setGoal] = useState<(typeof PAGE_GOALS)[number]>('views');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="r-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setFieldErrors({});
        try {
          await apiFetch(`/api/v1/workspaces/${workspaceId}/pages`, {
            body: { name, timezone, weekStart, goal },
          });
          toast('success', `Page “${name}” created.`);
          setName('');
          router.refresh();
        } catch (err) {
          if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="r-grid">
        <Field id={`${ids}-name`} label="Name" error={fieldErrors.name?.[0]}>
          <input
            id={`${ids}-name`}
            className="r-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </Field>
        <Field
          id={`${ids}-tz`}
          label="Time zone"
          hint="IANA zone, e.g. Europe/Berlin"
          error={fieldErrors.timezone?.[0]}
        >
          <input
            id={`${ids}-tz`}
            className="r-input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            required
          />
        </Field>
        <Field id={`${ids}-week`} label="Week starts on">
          <select
            id={`${ids}-week`}
            className="r-select"
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value as 'monday' | 'sunday')}
          >
            <option value="monday">Monday</option>
            <option value="sunday">Sunday</option>
          </select>
        </Field>
        <Field id={`${ids}-goal`} label="Goal">
          <select
            id={`${ids}-goal`}
            className="r-select"
            value={goal}
            onChange={(e) => setGoal(e.target.value as (typeof PAGE_GOALS)[number])}
          >
            {PAGE_GOALS.map((g) => (
              <option key={g} value={g}>
                {PAGE_GOAL_LABELS[g]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error ? (
        <Banner tone="danger" live>
          {error}
        </Banner>
      ) : null}
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Create page
        </Button>
      </div>
    </form>
  );
}

export function AddDestinationForm({
  workspaceId,
  pageId,
  accounts,
}: {
  workspaceId: string;
  pageId: string;
  accounts: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [account, setAccount] = useState(accounts[0]?.id ?? '');
  const [visibility, setVisibility] = useState<(typeof VISIBILITIES)[number]>('public');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (accounts.length === 0)
    return (
      <p className="r-xs r-muted">
        Every connected account is already a destination here. Connect another account under
        Connections.
      </p>
    );
  return (
    <form
      className="r-row"
      style={{ alignItems: 'flex-end' }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await apiFetch(`/api/v1/workspaces/${workspaceId}/pages/${pageId}/destinations`, {
            body: { socialAccountId: account, defaultVisibility: visibility },
          });
          toast('success', 'Destination added.');
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field id={`${ids}-acc`} label="Add destination">
        <select
          id={`${ids}-acc`}
          className="r-select"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${ids}-vis`} label="Default visibility">
        <select
          id={`${ids}-vis`}
          className="r-select"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as (typeof VISIBILITIES)[number])}
        >
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABELS[v]}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" busy={busy}>
        Add
      </Button>
      {error ? (
        <span className="r-error-text" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
