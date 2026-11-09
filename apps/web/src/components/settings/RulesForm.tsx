'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import type { PublishingRules } from '@relay/domain';
import { Banner, Button, Card, Field } from '@relay/ui';
import { useToast } from '@relay/ui/client';
import { ApiError, apiFetch, errorMessage } from '@/lib/client/api';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function RulesForm({
  workspaceId,
  pageId,
  revision,
  rules: initial,
  canEdit,
  canAutomate,
}: {
  workspaceId: string;
  pageId: string;
  revision: number;
  rules: PublishingRules;
  canEdit: boolean;
  canAutomate: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [rules, setRules] = useState<PublishingRules>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PublishingRules>(key: K, value: PublishingRules[K]) =>
    setRules((r) => ({ ...r, [key]: value }));
  const num = (
    key: 'minGapMinutes' | 'maxPerDay' | 'maxPerWeek' | 'leadMinutes' | 'lateGraceMinutes',
    label: string,
    hint?: string,
  ) => (
    <Field id={`${ids}-${key}`} label={label} hint={hint} error={fieldErrors[`rules.${key}`]?.[0]}>
      <input
        id={`${ids}-${key}`}
        type="number"
        min={0}
        className="r-input r-tabular"
        value={rules[key]}
        disabled={!canEdit}
        onChange={(e) => set(key, Number(e.target.value))}
      />
    </Field>
  );
  return (
    <form
      className="r-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setFieldErrors({});
        try {
          const result = await apiFetch<{ revision: number }>(
            `/api/v1/workspaces/${workspaceId}/pages/${pageId}/publishing-rules`,
            { method: 'PUT', body: { expectedRevision: revision, rules } },
          );
          toast(
            'success',
            `Saved as revision ${result.revision}. Existing schedules keep their planned instants.`,
          );
          router.refresh();
        } catch (err) {
          if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card className="r-stack">
        <div className="r-spread">
          <h2>Posting windows</h2>
          <span className="r-xs r-muted">Revision {revision}</span>
        </div>
        <p className="r-small r-muted">
          Preferred local times. Cold-start suggestions come only from these windows and your pacing
          rules — no performance data is used yet.
        </p>
        {rules.postingWindows.map((w, index) => (
          <fieldset key={index} className="r-fieldset r-stack-sm">
            <legend>{w.label || `Window ${index + 1}`}</legend>
            <div className="r-row" style={{ alignItems: 'flex-end' }}>
              <Field id={`${ids}-w${index}-label`} label="Label">
                <input
                  id={`${ids}-w${index}-label`}
                  className="r-input"
                  value={w.label}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set(
                      'postingWindows',
                      rules.postingWindows.map((x, i) =>
                        i === index ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field id={`${ids}-w${index}-start`} label="From">
                <input
                  id={`${ids}-w${index}-start`}
                  type="time"
                  className="r-input"
                  value={w.start}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set(
                      'postingWindows',
                      rules.postingWindows.map((x, i) =>
                        i === index ? { ...x, start: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field id={`${ids}-w${index}-end`} label="Until">
                <input
                  id={`${ids}-w${index}-end`}
                  type="time"
                  className="r-input"
                  value={w.end}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set(
                      'postingWindows',
                      rules.postingWindows.map((x, i) =>
                        i === index ? { ...x, end: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field id={`${ids}-w${index}-prio`} label="Priority (1–5)">
                <input
                  id={`${ids}-w${index}-prio`}
                  type="number"
                  min={1}
                  max={5}
                  className="r-input"
                  value={w.priority}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set(
                      'postingWindows',
                      rules.postingWindows.map((x, i) =>
                        i === index ? { ...x, priority: Number(e.target.value) } : x,
                      ),
                    )
                  }
                />
              </Field>
              {canEdit ? (
                <Button
                  variant="ghost"
                  aria-label={`Remove ${w.label || `window ${index + 1}`}`}
                  icon={<Trash2 aria-hidden />}
                  onClick={() =>
                    set(
                      'postingWindows',
                      rules.postingWindows.filter((_, i) => i !== index),
                    )
                  }
                />
              ) : null}
            </div>
            <div className="r-row-tight" role="group" aria-label="Days">
              {DAY_LABELS.map((label, d) => (
                <label key={label} className="r-check" style={{ paddingTop: 0 }}>
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={w.days.includes(d + 1)}
                    onChange={(e) =>
                      set(
                        'postingWindows',
                        rules.postingWindows.map((x, i) =>
                          i === index
                            ? {
                                ...x,
                                days: e.target.checked
                                  ? [...x.days, d + 1].sort()
                                  : x.days.filter((n) => n !== d + 1),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                  <span className="r-small">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {canEdit ? (
          <div>
            <Button
              icon={<Plus aria-hidden />}
              onClick={() =>
                set('postingWindows', [
                  ...rules.postingWindows,
                  {
                    label: 'New window',
                    days: [1, 2, 3, 4, 5],
                    start: '12:00',
                    end: '13:00',
                    priority: 3,
                  },
                ])
              }
            >
              Add window
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="r-stack">
        <h2>Pacing and safety</h2>
        <div className="r-grid">
          {num('minGapMinutes', 'Minimum gap per account (minutes)')}
          {num('maxPerDay', 'Maximum posts per account per day')}
          {num('maxPerWeek', 'Maximum posts per account per week')}
          {num(
            'leadMinutes',
            'Preparation lead time (minutes)',
            'Minimum time between scheduling and publishing.',
          )}
          {num(
            'lateGraceMinutes',
            'Late grace (minutes)',
            'If Relay cannot start in time, posts later than this go to review instead of publishing late.',
          )}
          <Field id={`${ids}-amb`} label="When a time happens twice (DST)">
            <select
              id={`${ids}-amb`}
              className="r-select"
              value={rules.ambiguousTimePolicy}
              disabled={!canEdit}
              onChange={(e) =>
                set('ambiguousTimePolicy', e.target.value as PublishingRules['ambiguousTimePolicy'])
              }
            >
              <option value="ask">Ask every time (recommended)</option>
              <option value="earlier">Always the first occurrence</option>
              <option value="later">Always the second occurrence</option>
            </select>
          </Field>
        </div>
        <fieldset className="r-fieldset r-stack-sm">
          <legend>Quiet hours (nothing is published)</legend>
          {rules.quietHours.map((q, index) => (
            <div key={index} className="r-row" style={{ alignItems: 'flex-end' }}>
              <Field id={`${ids}-q${index}-s`} label="From">
                <input
                  id={`${ids}-q${index}-s`}
                  type="time"
                  className="r-input"
                  value={q.start}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set(
                      'quietHours',
                      rules.quietHours.map((x, i) =>
                        i === index ? { ...x, start: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field id={`${ids}-q${index}-e`} label="Until">
                <input
                  id={`${ids}-q${index}-e`}
                  type="time"
                  className="r-input"
                  value={q.end}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set(
                      'quietHours',
                      rules.quietHours.map((x, i) =>
                        i === index ? { ...x, end: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              {canEdit ? (
                <Button
                  variant="ghost"
                  aria-label="Remove quiet hours"
                  icon={<Trash2 aria-hidden />}
                  onClick={() =>
                    set(
                      'quietHours',
                      rules.quietHours.filter((_, i) => i !== index),
                    )
                  }
                />
              ) : null}
            </div>
          ))}
          {canEdit && rules.quietHours.length < 4 ? (
            <div>
              <Button
                icon={<Plus aria-hidden />}
                onClick={() =>
                  set('quietHours', [...rules.quietHours, { start: '23:00', end: '07:00' }])
                }
              >
                Add quiet hours
              </Button>
            </div>
          ) : null}
        </fieldset>
        <Field
          id={`${ids}-auto`}
          label="Automation"
          hint="Supervised automation arrives in M6. Auto-publish is off by default and can only be enabled by owners and admins."
        >
          <select
            id={`${ids}-auto`}
            className="r-select"
            value={rules.automation.mode}
            disabled={!canEdit || !canAutomate}
            onChange={(e) =>
              set('automation', { mode: e.target.value as PublishingRules['automation']['mode'] })
            }
          >
            <option value="off">Off</option>
            <option value="suggest" disabled>
              Suggestions only (M6)
            </option>
            <option value="queue_for_approval" disabled>
              Queue for approval (M6)
            </option>
          </select>
        </Field>
      </Card>

      {error ? (
        <Banner tone="danger" live title="Not saved">
          {error}
        </Banner>
      ) : null}
      {canEdit ? (
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Save as new revision
          </Button>
        </div>
      ) : (
        <p className="r-small r-muted">Only owners and admins can change publishing rules.</p>
      )}
    </form>
  );
}

export function PauseControl({
  workspaceId,
  pageId,
  paused,
  reason,
  canPause,
  canResume,
}: {
  workspaceId: string;
  pageId: string;
  paused: boolean;
  reason: string | null;
  canPause: boolean;
  canResume: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="r-stack-sm">
      <div className="r-spread">
        <div className="r-stack-sm" style={{ gap: 2 }}>
          <h2>{paused ? 'Page is paused' : 'Publishing is active'}</h2>
          <p className="r-small r-muted">
            {paused
              ? `Reason: ${reason ?? 'not given'}. No new posts will be claimed for publishing.`
              : 'Pausing stops new publishing claims immediately. Posts already sent to a platform are reported, not hidden.'}
          </p>
        </div>
        {paused ? (
          canResume ? (
            <Button
              variant="primary"
              icon={<Play aria-hidden />}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await apiFetch<{ resumed: number }>(
                    `/api/v1/workspaces/${workspaceId}/pages/${pageId}/pause`,
                    { method: 'DELETE' },
                  );
                  toast(
                    'success',
                    `Resumed. ${r.resumed} held post${r.resumed === 1 ? '' : 's'} will continue (late ones go to review).`,
                  );
                  router.refresh();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Resume
            </Button>
          ) : null
        ) : canPause ? (
          <div className="r-row" style={{ alignItems: 'flex-end' }}>
            <Field id="pause-reason" label="Reason (optional)">
              <input
                id="pause-reason"
                className="r-input"
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                maxLength={280}
              />
            </Field>
            <Button
              icon={<Pause aria-hidden />}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const r = await apiFetch<{ inFlight: unknown[]; held: number }>(
                    `/api/v1/workspaces/${workspaceId}/pages/${pageId}/pause`,
                    { body: why ? { reason: why } : {} },
                  );
                  toast(
                    'info',
                    `Paused. ${r.held} scheduled post${r.held === 1 ? '' : 's'} held; ${r.inFlight.length} already in flight will still be reported.`,
                  );
                  router.refresh();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Pause page
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <Banner tone="danger" live>
          {error}
        </Banner>
      ) : null}
    </Card>
  );
}
