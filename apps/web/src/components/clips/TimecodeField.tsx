'use client';

import { useState, type ReactNode } from 'react';
import { describedBy, Field } from '@relay/ui';
import { formatTimecode, parseTimecode } from './time';

/**
 * A time on the source timeline as a typed field: `mm:ss.s` or plain seconds. The value is
 * committed on blur or Enter; text that is not a time stays in the field with an error so it
 * can be corrected rather than silently reverted.
 */
export function TimecodeField({
  id,
  label,
  valueMs,
  onCommit,
  error,
  hint,
  disabled,
  compact,
}: {
  id: string;
  label: ReactNode;
  valueMs: number;
  onCommit: (ms: number) => void;
  error?: string | null;
  hint?: ReactNode;
  disabled?: boolean;
  /** Narrow field for table-like rows. */
  compact?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const shownError = parseError ?? error ?? null;

  function commit() {
    if (draft === null) return;
    const ms = parseTimecode(draft);
    if (ms === null) {
      setParseError('Enter a time such as 1:23.4, or seconds such as 83.4');
      return;
    }
    setParseError(null);
    setDraft(null);
    if (ms !== valueMs) onCommit(ms);
  }

  return (
    <Field id={id} label={label} hint={hint} error={shownError}>
      <input
        id={id}
        className={compact ? 'r-input r-tabular timecode-input' : 'r-input r-tabular'}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft ?? formatTimecode(valueMs)}
        disabled={disabled}
        aria-invalid={shownError ? 'true' : undefined}
        aria-describedby={describedBy(id, { hint, error: shownError })}
        onChange={(e) => {
          setDraft(e.target.value);
          setParseError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && draft !== null) {
            setDraft(null);
            setParseError(null);
          }
        }}
      />
    </Field>
  );
}
