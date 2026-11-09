'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Plug, Unplug } from 'lucide-react';
import { DESTINATION_PROVIDERS, PROVIDER_LABELS } from '@relay/domain';
import { Banner, Button, Field } from '@relay/ui';
import { Dialog, useToast } from '@relay/ui/client';
import { apiFetch, errorMessage } from '@/lib/client/api';

const PROFILES = [
  ['reliable', 'Reliable — publishes normally'],
  ['slow_processing', 'Slow processing — takes several checks'],
  ['rate_limited_once', 'Rate limited once, then succeeds'],
  ['transient_then_ok', 'Temporary error once, then succeeds'],
  ['lost_response', 'Loses the response; reconciliation finds the post'],
  ['ambiguous', 'Ambiguous outcome; needs an operator'],
  ['reject_format', 'Always rejects the media'],
] as const;

export function DemoConnectionForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [provider, setProvider] = useState<(typeof DESTINATION_PROVIDERS)[number]>('youtube');
  const [displayName, setDisplayName] = useState('');
  const [profile, setProfile] = useState<(typeof PROFILES)[number][0]>('reliable');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="r-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await apiFetch<{ label: string }>(
            `/api/v1/workspaces/${workspaceId}/connections/demo`,
            { body: { provider, displayName, profile } },
          );
          toast('success', `Connected ${r.label}.`);
          setDisplayName('');
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Add a simulated account (demo mode)</h3>
      <div className="r-grid">
        <Field id={`${ids}-p`} label="Platform">
          <select
            id={`${ids}-p`}
            className="r-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value as (typeof DESTINATION_PROVIDERS)[number])}
          >
            {DESTINATION_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]} (simulated)
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-n`} label="Account name">
          <input
            id={`${ids}-n`}
            className="r-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            maxLength={80}
          />
        </Field>
        <Field id={`${ids}-b`} label="Simulator behaviour">
          <select
            id={`${ids}-b`}
            className="r-select"
            value={profile}
            onChange={(e) => setProfile(e.target.value as (typeof PROFILES)[number][0])}
          >
            {PROFILES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
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
        <Button type="submit" icon={<Plug aria-hidden />} busy={busy}>
          Connect simulated account
        </Button>
      </div>
    </form>
  );
}

export function DisconnectButton({
  workspaceId,
  accountId,
  name,
}: {
  workspaceId: string;
  accountId: string;
  name: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button variant="ghost" icon={<Unplug aria-hidden />} onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Disconnect ${name}?`}
        description="Scheduled posts for this account are held immediately. Anything already sent to the platform is reported so it can be reconciled."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep connected
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await apiFetch<{ held: number; inFlight: string[] }>(
                    `/api/v1/workspaces/${workspaceId}/connections/${accountId}`,
                    { method: 'DELETE' },
                  );
                  toast(
                    'info',
                    `Disconnected. ${r.held} scheduled post${r.held === 1 ? '' : 's'} held; ${r.inFlight.length} in flight.`,
                  );
                  setOpen(false);
                  router.refresh();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Disconnect
            </Button>
          </>
        }
      >
        {error ? (
          <Banner tone="danger" live>
            {error}
          </Banner>
        ) : (
          <p className="r-small">You can connect the account again later.</p>
        )}
      </Dialog>
    </>
  );
}
