'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { CalendarClock, Lock, Zap } from 'lucide-react';
import { PROVIDER_LABELS, VISIBILITY_LABELS, type DestinationProviderId, type Visibility } from '@relay/domain';
import { Banner, Button, Field, SimulatedBadge, Spinner } from '@relay/ui';
import { Dialog, useToast } from '@relay/ui/client';
import { ApiError, apiFetch, errorMessage, newIdempotencyKey } from '@/lib/client/api';
import { formatDateTime, zoneLabel } from '@/lib/format';

export interface ScheduleTarget {
  postDestinationId: string;
  version: number;
  label: string;
  accountName: string;
  provider: string;
  connectionMode: string;
  visibility: string;
}

interface Suggestion {
  slotAt: string;
  civil: string;
  offset: string;
  windowLabel: string;
  reasons: string[];
  dataOrigin: string;
}

function todayIn(zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface ScheduleDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  zone: string;
  target: ScheduleTarget | null;
  mode?: 'schedule' | 'move';
  initialLocal?: string | null;
}

/**
 * The form is keyed by what is being scheduled, so every opening starts from fresh state
 * (and a fresh idempotency key) instead of resetting state in an effect.
 */
export function ScheduleDialog(props: ScheduleDialogProps) {
  if (!props.open || !props.target) return null;
  const { target } = props;
  return <ScheduleForm key={`${target.postDestinationId}:${target.version}:${props.initialLocal ?? ''}`} {...props} target={target} />;
}

function ScheduleForm({
  open,
  onClose,
  workspaceId,
  zone,
  target,
  mode = 'schedule',
  initialLocal,
}: ScheduleDialogProps & { target: ScheduleTarget }) {
  const router = useRouter();
  const toast = useToast();
  const ids = useId();
  const [choice, setChoice] = useState<'suggested' | 'custom' | 'asap'>(initialLocal ? 'custom' : 'suggested');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [explanation, setExplanation] = useState<string>('');
  const [picked, setPicked] = useState<string | null>(null);
  const [date, setDate] = useState(initialLocal?.slice(0, 10) ?? addDaysIso(todayIn(zone), 1));
  const [time, setTime] = useState(initialLocal?.slice(11, 16) ?? '09:00');
  const [lock, setLock] = useState(false);
  const [offset, setOffset] = useState<string | null>(null);
  const [ambiguity, setAmbiguity] = useState<Array<{ instant: string; offset: string }> | null>(null);
  const [gapSuggestion, setGapSuggestion] = useState<{ civil: string } | null>(null);
  const [violations, setViolations] = useState<Array<{ message: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per opening: a lost response can be retried safely; a changed time after a
  // refusal is fine too, because refused requests are not recorded.
  const [idempotencyKey] = useState(() => newIdempotencyKey('schedule'));
  const postDestinationId = target.postDestinationId;

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ results: Array<{ suggestions: Suggestion[]; explanation: string }> }>(`/api/v1/workspaces/${workspaceId}/recommendations/slots`, {
      body: { postDestinationIds: [postDestinationId], count: 5 },
    })
      .then((r) => {
        if (cancelled) return;
        const s = r.results[0]?.suggestions ?? [];
        setSuggestions(s);
        setExplanation(r.results[0]?.explanation ?? '');
        setPicked(s[0]?.civil ?? null);
        if (s.length === 0 && !initialLocal) setChoice('custom');
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, postDestinationId, initialLocal]);

  const localTime = choice === 'suggested' ? picked : choice === 'custom' ? `${date}T${time}` : null;
  const suggestion = suggestions?.find((s) => s.civil === picked);

  async function submit(overrideOffset?: string, overrideLocal?: string) {
    setBusy(true);
    setError(null);
    setViolations([]);
    try {
      const body =
        choice === 'asap'
          ? { expectedVersion: target.version, mode: 'asap', lockSlot: lock }
          : {
              expectedVersion: target.version,
              mode: 'at',
              localTime: overrideLocal ?? localTime,
              ...(overrideOffset ?? offset ?? (choice === 'suggested' ? suggestion?.offset : undefined) ? { offset: overrideOffset ?? offset ?? suggestion?.offset } : {}),
              lockSlot: lock,
            };
      const result = await apiFetch<{ civil: string; offset: string; zone: string; warnings: Array<{ message: string }> }>(
        `/api/v1/workspaces/${workspaceId}/post-destinations/${target.postDestinationId}/schedule`,
        { body, idempotencyKey: overrideOffset || overrideLocal ? newIdempotencyKey('schedule') : idempotencyKey },
      );
      toast('success', `${mode === 'move' ? 'Moved' : 'Scheduled'} for ${result.civil.replace('T', ' ')} (${result.zone}, ${result.offset}).${result.warnings.map((w) => ` ${w.message}`).join('')}`);
      onClose();
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'ambiguous_local_time') setAmbiguity((e.details?.options as Array<{ instant: string; offset: string }>) ?? null);
        if (e.code === 'nonexistent_local_time') setGapSuggestion((e.details?.suggestion as { civil: string }) ?? null);
        const v = e.details?.violations as Array<{ message: string }> | undefined;
        if (v?.length) setViolations(v);
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const provider = PROVIDER_LABELS[target.provider as DestinationProviderId] ?? target.provider;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={mode === 'move' ? 'Move post' : 'Schedule post'}
      description={`Times are in ${zoneLabel(zone)}, the page’s time zone.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={choice !== 'asap' && !localTime} onClick={() => submit()} icon={<CalendarClock aria-hidden />}>
            {mode === 'move' ? 'Move' : choice === 'asap' ? 'Publish as soon as possible' : 'Schedule'}
          </Button>
        </>
      }
    >
      <fieldset className="r-fieldset r-stack-sm">
        <legend>When</legend>
        <label className="r-check"><input type="radio" name={`${ids}-when`} checked={choice === 'suggested'} onChange={() => setChoice('suggested')} /> <span className="r-small">A suggested slot</span></label>
        {choice === 'suggested' ? (
          <div className="r-stack-sm" style={{ paddingLeft: 32 }}>
            {suggestions === null ? <Spinner label="Finding open slots" /> : null}
            {suggestions && suggestions.length === 0 ? <p className="r-small r-muted">{explanation || 'No open slots in the next two weeks.'}</p> : null}
            {suggestions && suggestions.length > 0 ? (
              <>
                <p className="r-xs r-muted">{explanation} Suggestions are not reserved until you schedule.</p>
                <div role="radiogroup" aria-label="Suggested slots" className="r-stack-sm">
                  {suggestions.map((s) => (
                    <label key={s.slotAt} className="slot-option">
                      <input type="radio" name={`${ids}-slot`} checked={picked === s.civil} onChange={() => setPicked(s.civil)} />
                      <span className="r-stack-sm" style={{ gap: 2 }}>
                        <span className="r-strong r-tabular">{formatDateTime(s.slotAt, zone)} <span className="r-muted r-xs">({s.offset})</span></span>
                        <span className="r-xs r-muted">Suggested · {s.reasons.join(' · ')}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        <label className="r-check"><input type="radio" name={`${ids}-when`} checked={choice === 'custom'} onChange={() => setChoice('custom')} /> <span className="r-small">A specific time</span></label>
        {choice === 'custom' ? (
          <div className="r-row" style={{ paddingLeft: 32, alignItems: 'flex-end' }}>
            <Field id={`${ids}-date`} label="Date">
              <input id={`${ids}-date`} type="date" className="r-input" value={date} onChange={(e) => { setDate(e.target.value); setOffset(null); setAmbiguity(null); setGapSuggestion(null); }} />
            </Field>
            <Field id={`${ids}-time`} label="Time">
              <input id={`${ids}-time`} type="time" className="r-input" value={time} step={300} onChange={(e) => { setTime(e.target.value); setOffset(null); setAmbiguity(null); setGapSuggestion(null); }} />
            </Field>
          </div>
        ) : null}
        <label className="r-check"><input type="radio" name={`${ids}-when`} checked={choice === 'asap'} onChange={() => setChoice('asap')} /> <span className="r-small r-row-tight"><Zap aria-hidden width={16} height={16} /> As soon as possible (still respects quiet hours and spacing)</span></label>
      </fieldset>

      {ambiguity ? (
        <fieldset className="r-fieldset r-stack-sm">
          <legend>This time happens twice (clocks go back)</legend>
          {ambiguity.map((o, i) => (
            <label key={o.offset} className="r-check">
              <input type="radio" name={`${ids}-offset`} checked={offset === o.offset} onChange={() => setOffset(o.offset)} />
              <span className="r-small r-tabular">{i === 0 ? 'First' : 'Second'} occurrence ({o.offset}) — {new Date(o.instant).toISOString().replace('.000Z', 'Z')}</span>
            </label>
          ))}
          <div><Button disabled={!offset} onClick={() => submit(offset!)}>Use this occurrence</Button></div>
        </fieldset>
      ) : null}
      {gapSuggestion ? (
        <Banner tone="warning" title="That time does not exist (clocks go forward)">
          <Button onClick={() => { setDate(gapSuggestion.civil.slice(0, 10)); setTime(gapSuggestion.civil.slice(11, 16)); setGapSuggestion(null); void submit(undefined, gapSuggestion.civil); }}>
            Use {gapSuggestion.civil.slice(11, 16)} instead
          </Button>
        </Banner>
      ) : null}

      <label className="r-check">
        <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
        <span className="r-small r-row-tight"><Lock aria-hidden width={16} height={16} /> Lock this slot so it is not moved accidentally</span>
      </label>

      <div className="confirm-summary r-stack-sm" aria-live="polite">
        <span className="r-section-title">You are about to publish to</span>
        <span className="r-row-tight r-strong">{target.accountName} · {provider} {target.connectionMode === 'simulated' ? <SimulatedBadge /> : null}</span>
        <dl className="r-dl">
          <dt>Destination</dt><dd>{target.label}</dd>
          <dt>Visibility</dt><dd>{VISIBILITY_LABELS[target.visibility as Visibility] ?? target.visibility}</dd>
          <dt>Local time</dt>
          <dd className="r-tabular">
            {choice === 'asap' ? 'As soon as possible' : localTime ? `${localTime.replace('T', ' ')} ${zone}${offset ? ` (${offset})` : suggestion && choice === 'suggested' ? ` (${suggestion.offset})` : ''}` : '—'}
          </dd>
        </dl>
        {target.connectionMode === 'simulated' ? <span className="r-xs r-muted">Simulated account: the provider simulator receives this post. Nothing is sent to a real platform.</span> : null}
      </div>

      {error ? (
        <Banner tone="danger" live title={error}>
          {violations.length > 1 ? <ul style={{ margin: 0, paddingLeft: 18 }}>{violations.map((v) => <li key={v.message}>{v.message}</li>)}</ul> : null}
        </Banner>
      ) : null}
    </Dialog>
  );
}
