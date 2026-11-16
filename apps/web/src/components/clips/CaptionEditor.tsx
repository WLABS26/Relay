'use client';

import { memo, useEffect, useId, useRef, useState } from 'react';
import { FileUp, Play, Plus, Trash2 } from 'lucide-react';
import {
  CAPTION_MAX_CUES,
  CAPTION_MAX_INPUT_BYTES,
  CAPTION_MAX_LINE_CHARS,
  CAPTION_MAX_LINES,
  CAPTION_MIN_CUE_MS,
  type Cue,
} from '@relay/domain';
import { Banner, Button, describedBy, Field } from '@relay/ui';
import { ApiError, apiFetch, errorMessage } from '@/lib/client/api';
import { formatBytes } from '@/lib/format';
import { clampMs, snapMs } from './time';
import { TimecodeField } from './TimecodeField';

export interface EditorCue extends Cue {
  /** Stable React key; never sent to the server. */
  key: string;
}

export type CueErrors = Record<number, { startMs?: string; endMs?: string; text?: string }>;

let cueSeq = 0;
export const withCueKeys = (cues: readonly Cue[] | null): EditorCue[] =>
  (cues ?? []).map((cue) => ({ ...cue, key: `cue-${++cueSeq}` }));

/**
 * Burned-in captions as editable cues on the source timeline, so they survive a change of the
 * clip range. Cues can be typed, added at the playhead, or imported from an SRT or WebVTT file,
 * which the server parses and re-serialises (the file itself is never stored).
 */
export const CaptionEditor = memo(function CaptionEditor({
  workspaceId,
  clipId,
  cues,
  errors,
  trackError,
  clipStartMs,
  clipEndMs,
  disabled,
  onChange,
  getPlayheadMs,
  onPreviewCue,
}: {
  workspaceId: string;
  clipId: string;
  cues: EditorCue[];
  errors: CueErrors;
  trackError: string | null;
  clipStartMs: number;
  clipEndMs: number;
  disabled: boolean;
  onChange: (cues: EditorCue[]) => void;
  getPlayheadMs: () => number;
  onPreviewCue: (ms: number) => void;
}) {
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const addButton = useRef<HTMLDivElement>(null);
  const [relativeTo, setRelativeTo] = useState<'clip' | 'source'>('clip');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<{ message: string; details: string[] } | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Move focus into a cue that was just added, so typing can continue without the pointer.
  useEffect(() => {
    if (!focusKey) return;
    list.current?.querySelector<HTMLTextAreaElement>(`[data-cue="${focusKey}"] textarea`)?.focus();
  }, [focusKey]);

  // Removing a cue removes the focused button with it: hand focus to the neighbouring cue, or
  // to "Add cue" when none is left, so keyboard users are not sent back to the top of the page.
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ key: string | null } | null>(null);
  useEffect(() => {
    if (!focusAfterRemove) return;
    const target = focusAfterRemove.key
      ? list.current?.querySelector<HTMLElement>(
          `[data-cue="${focusAfterRemove.key}"] .cue-row__actions button:last-of-type`,
        )
      : addButton.current?.querySelector<HTMLElement>('button');
    target?.focus();
  }, [focusAfterRemove]);

  const update = (key: string, patch: Partial<Cue>) =>
    onChange(cues.map((cue) => (cue.key === key ? { ...cue, ...patch } : cue)));

  function addCue() {
    const playhead = snapMs(getPlayheadMs());
    const inside = playhead >= clipStartMs && playhead < clipEndMs - CAPTION_MIN_CUE_MS;
    const lastEnd = cues.at(-1)?.endMs ?? clipStartMs;
    // At the playhead when it is inside the clip; otherwise after the last cue.
    const startMs = inside
      ? playhead
      : clampMs(lastEnd, clipStartMs, clipEndMs - CAPTION_MIN_CUE_MS);
    const endMs = Math.max(startMs + CAPTION_MIN_CUE_MS, Math.min(startMs + 2000, clipEndMs));
    const cue: EditorCue = { key: `cue-${++cueSeq}`, startMs, endMs, text: '' };
    const index = cues.findIndex((c) => c.startMs > startMs);
    onChange(index === -1 ? [...cues, cue] : [...cues.slice(0, index), cue, ...cues.slice(index)]);
    setFocusKey(cue.key);
    setNotice('');
  }

  async function importFile(file: File) {
    setImportError(null);
    setNotice('');
    if (file.size > CAPTION_MAX_INPUT_BYTES) {
      setImportError({
        message: `${file.name} is ${formatBytes(file.size)}; caption files can be at most ${formatBytes(CAPTION_MAX_INPUT_BYTES)}.`,
        details: [],
      });
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      // trimStart also drops a byte order mark, which many subtitle tools write.
      const isVtt = /\.vtt$/i.test(file.name) || text.trimStart().startsWith('WEBVTT');
      const format = isVtt ? 'vtt' : 'srt';
      const result = await apiFetch<{ cues: Cue[] }>(
        `/api/v1/workspaces/${workspaceId}/clips/${clipId}/captions/import`,
        { body: { format, text, relativeTo } },
      );
      onChange(withCueKeys(result.cues));
      setNotice(
        `Imported ${result.cues.length} cue${result.cues.length === 1 ? '' : 's'} from ${file.name}. Save the clip to keep them.`,
      );
    } catch (error) {
      const details =
        error instanceof ApiError && error.fieldErrors
          ? Object.entries(error.fieldErrors)
              // A single problem is already the message itself.
              .filter(([, messages]) => messages.join('; ') !== error.message)
              .slice(0, 8)
              .map(([field, messages]) => `${describeField(field)}: ${messages.join('; ')}`)
          : [];
      setImportError({ message: errorMessage(error), details });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="r-stack">
      <p className="r-small r-muted">
        Captions are burned into the picture. Up to {CAPTION_MAX_LINES} lines of{' '}
        {CAPTION_MAX_LINE_CHARS} characters per cue. Times are on the source video, so they stay in
        place when you change the clip range.
      </p>

      {trackError ? (
        <Banner tone="danger" live>
          {trackError}
        </Banner>
      ) : null}

      {cues.length > 0 ? (
        <ol className="cue-list" ref={list} aria-label="Caption cues">
          {cues.map((cue, index) => {
            const error = errors[index] ?? {};
            const n = index + 1;
            const textId = `${ids}-${cue.key}-text`;
            return (
              <li key={cue.key} className="cue-row" data-cue={cue.key}>
                <TimecodeField
                  compact
                  id={`${ids}-${cue.key}-start`}
                  label={
                    <>
                      Start<span className="r-visually-hidden"> of cue {n}</span>
                    </>
                  }
                  valueMs={cue.startMs}
                  disabled={disabled}
                  error={error.startMs ?? null}
                  onCommit={(ms) => update(cue.key, { startMs: ms })}
                />
                <TimecodeField
                  compact
                  id={`${ids}-${cue.key}-end`}
                  label={
                    <>
                      End<span className="r-visually-hidden"> of cue {n}</span>
                    </>
                  }
                  valueMs={cue.endMs}
                  disabled={disabled}
                  error={error.endMs ?? null}
                  onCommit={(ms) => update(cue.key, { endMs: ms })}
                />
                <div className="cue-row__text">
                  <Field
                    id={textId}
                    label={
                      <>
                        Text<span className="r-visually-hidden"> of cue {n}</span>
                      </>
                    }
                    error={error.text ?? null}
                  >
                    <textarea
                      id={textId}
                      className="r-textarea cue-row__textarea"
                      rows={2}
                      value={cue.text}
                      disabled={disabled}
                      aria-invalid={error.text ? 'true' : undefined}
                      aria-describedby={describedBy(textId, { error: error.text })}
                      onChange={(e) => update(cue.key, { text: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="cue-row__actions">
                  <Button
                    variant="ghost"
                    icon={<Play aria-hidden />}
                    aria-label={`Play from cue ${n}`}
                    onClick={() => onPreviewCue(cue.startMs)}
                  />
                  <Button
                    variant="ghost"
                    icon={<Trash2 aria-hidden />}
                    aria-label={`Remove cue ${n}`}
                    disabled={disabled}
                    onClick={() => {
                      onChange(cues.filter((c) => c.key !== cue.key));
                      setNotice(`Cue ${n} removed.`);
                      setFocusAfterRemove({
                        key: (cues[index + 1] ?? cues[index - 1])?.key ?? null,
                      });
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="r-small">No captions. The clip is rendered without text.</p>
      )}

      <div className="r-row-tight" ref={addButton}>
        <Button
          icon={<Plus aria-hidden />}
          disabled={disabled || cues.length >= CAPTION_MAX_CUES}
          onClick={addCue}
        >
          Add cue at playhead
        </Button>
        {cues.length > 0 ? (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              onChange([]);
              setNotice('All captions removed. Save the clip to keep this change.');
              setFocusAfterRemove({ key: null });
            }}
          >
            Remove all
          </Button>
        ) : null}
      </div>

      <fieldset className="r-fieldset r-stack-sm" disabled={disabled}>
        <legend>Import a caption file</legend>
        <Field
          id={`${ids}-relative`}
          label="Times in the file count from"
          hint={
            cues.length > 0
              ? 'Importing replaces the cues above. Nothing is saved until you save the clip.'
              : 'SRT or WebVTT. Formatting tags are removed; only the text and times are kept.'
          }
        >
          <select
            id={`${ids}-relative`}
            className="r-select"
            value={relativeTo}
            onChange={(e) => setRelativeTo(e.target.value === 'source' ? 'source' : 'clip')}
            aria-describedby={describedBy(`${ids}-relative`, { hint: true })}
          >
            <option value="clip">The start of this clip</option>
            <option value="source">The start of the source video</option>
          </select>
        </Field>
        <div>
          <Button
            icon={<FileUp aria-hidden />}
            busy={importing}
            onClick={() => fileInput.current?.click()}
          >
            Choose SRT or VTT file
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".srt,.vtt,text/vtt,application/x-subrip"
            className="r-visually-hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </div>
        {importError ? (
          <Banner tone="danger" live title="The file was not imported">
            <p>{importError.message}</p>
            {importError.details.length > 0 ? (
              <ul className="plain-list">
                {importError.details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}
      </fieldset>

      <p className="r-small" role="status">
        {notice}
      </p>
    </div>
  );
});

/** `captions.3.text` as "Cue 4 text". */
export function describeField(field: string): string {
  const whole = /^captions\.(\d+)$/.exec(field);
  if (whole) return `Cue ${Number(whole[1]) + 1}`;
  const match = /^captions\.(\d+)\.(startMs|endMs|text)$/.exec(field);
  if (!match) return field === 'text' ? 'File' : field === 'captions' ? 'Captions' : field;
  const part = match[2] === 'startMs' ? 'start' : match[2] === 'endMs' ? 'end' : 'text';
  return `Cue ${Number(match[1]) + 1} ${part}`;
}
