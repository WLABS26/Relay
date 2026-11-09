'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Banner, Button, Field } from '@relay/ui';
import { Dialog, useToast } from '@relay/ui/client';
import { apiFetch, errorMessage } from '@/lib/client/api';

/**
 * Resolve an unknown outcome. Relay never resends on its own when the platform cannot say
 * whether it received the post; a person checks the platform and records what they found.
 */
export function ReconcileDialog({
  open,
  onClose,
  workspaceId,
  target,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  target: { postDestinationId: string; version: number; label: string; simulated: boolean } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [action, setAction] = useState<'link_external' | 'close_not_published'>('link_external');
  const [externalId, setExternalId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Resolve unknown outcome"
      description={`Relay cannot prove whether ${target.label} received this post, so it will not resend automatically.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action === 'close_not_published' ? 'danger' : 'primary'}
            busy={busy}
            disabled={
              reason.trim().length < 3 || (action === 'link_external' && !externalId.trim())
            }
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiFetch(
                  `/api/v1/workspaces/${workspaceId}/post-destinations/${target.postDestinationId}/reconcile`,
                  {
                    body:
                      action === 'link_external'
                        ? {
                            action,
                            expectedVersion: target.version,
                            externalId: externalId.trim(),
                            reason: reason.trim(),
                          }
                        : { action, expectedVersion: target.version, reason: reason.trim() },
                  },
                );
                toast(
                  'success',
                  action === 'link_external'
                    ? 'Linked the verified post.'
                    : 'Closed as not published. You can retry it.',
                );
                onClose();
                router.refresh();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {action === 'link_external' ? 'Link post' : 'Close as not published'}
          </Button>
        </>
      }
    >
      <fieldset className="r-fieldset r-stack-sm">
        <legend>What did you find on the platform?</legend>
        <label className="r-check">
          <input
            type="radio"
            name={`${ids}-a`}
            checked={action === 'link_external'}
            onChange={() => setAction('link_external')}
          />
          <span className="r-small">It was published — I will link the exact post</span>
        </label>
        <label className="r-check">
          <input
            type="radio"
            name={`${ids}-a`}
            checked={action === 'close_not_published'}
            onChange={() => setAction('close_not_published')}
          />
          <span className="r-small">It was not published</span>
        </label>
      </fieldset>
      {action === 'link_external' ? (
        <Field
          id={`${ids}-ext`}
          label="Platform post ID"
          hint={
            target.simulated
              ? 'Simulated platform: IDs look like sim_youtube_1a2b3c4d5e6f.'
              : 'Copy the ID from the platform. Relay never matches posts by title.'
          }
        >
          <input
            id={`${ids}-ext`}
            className="r-input"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            maxLength={200}
          />
        </Field>
      ) : null}
      <Field id={`${ids}-reason`} label="Reason (recorded in the audit trail)">
        <textarea
          id={`${ids}-reason`}
          className="r-textarea"
          style={{ minHeight: 80 }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </Field>
      {error ? (
        <Banner tone="danger" live>
          {error}
        </Banner>
      ) : null}
    </Dialog>
  );
}
