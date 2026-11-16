'use client';

import { useMemo, type KeyboardEvent, type PointerEvent } from 'react';
import type { Envelope } from '@relay/domain';
import { clampMs, formatTimecode, snapMs, spokenTimecode, TIME_STEP_MS } from './time';

const FLOOR_DB = -60;

/** Mirrored loudness outline; x is the envelope point index, y is 0..100. */
function wavePath(envelope: Envelope): string {
  const amplitude = (db: number) =>
    Math.min(1, Math.max(0.02, (Math.max(db, FLOOR_DB) - FLOOR_DB) / -FLOOR_DB));
  const top: string[] = [];
  const bottom: string[] = [];
  envelope.points.forEach((db, i) => {
    const a = amplitude(db) * 46;
    top.push(`${i},${(50 - a).toFixed(1)} ${i + 1},${(50 - a).toFixed(1)}`);
    bottom.push(`${i + 1},${(50 + a).toFixed(1)} ${i},${(50 + a).toFixed(1)}`);
  });
  return `M${top.join(' L')} L${bottom.reverse().join(' L')} Z`;
}

/**
 * The clip range on the source timeline, drawn over the loudness envelope. The two edges are
 * sliders: drag them, or focus one and use the arrow keys (0.1 s, with Shift 1 s, Page Up/Down
 * 5 s, Home/End for the ends of the visible stretch). The numeric fields and the "set to
 * playhead" buttons beside the bar do the same without dragging.
 */
export function TrimBar({
  durationMs,
  view,
  startMs,
  endMs,
  minMs,
  playheadMs,
  envelope,
  disabled,
  onStart,
  onEnd,
  onSeek,
}: {
  durationMs: number;
  /** The stretch of the source the bar shows. */
  view: { fromMs: number; toMs: number };
  startMs: number;
  endMs: number;
  minMs: number;
  playheadMs: number;
  envelope: Envelope | null;
  disabled?: boolean;
  onStart: (ms: number) => void;
  onEnd: (ms: number) => void;
  onSeek: (ms: number) => void;
}) {
  const span = Math.max(1, view.toMs - view.fromMs);
  const pct = (ms: number) => `${(clampMs((ms - view.fromMs) / span, 0, 1) * 100).toFixed(3)}%`;
  const path = useMemo(() => (envelope ? wavePath(envelope) : null), [envelope]);

  const limits = {
    start: { min: 0, max: endMs - minMs },
    end: { min: startMs + minMs, max: durationMs },
  };

  /** The time under a pointer position, measured against the track element. */
  function msAt(trackElement: Element | null, clientX: number): number {
    const rect = trackElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return view.fromMs;
    const ratio = clampMs((clientX - rect.left) / rect.width, 0, 1);
    return snapMs(view.fromMs + ratio * span);
  }

  function thumbProps(edge: 'start' | 'end') {
    const value = edge === 'start' ? startMs : endMs;
    const set = edge === 'start' ? onStart : onEnd;
    const { min, max } = limits[edge];
    const move = (ms: number) => {
      const next = clampMs(ms, min, max);
      if (next !== value) set(next);
    };
    return {
      role: 'slider' as const,
      tabIndex: disabled ? -1 : 0,
      'aria-label': edge === 'start' ? 'Clip start' : 'Clip end',
      'aria-orientation': 'horizontal' as const,
      'aria-valuemin': Math.round(min / 100) / 10,
      'aria-valuemax': Math.round(max / 100) / 10,
      'aria-valuenow': Math.round(value / 100) / 10,
      'aria-valuetext': `${edge === 'start' ? 'Start' : 'End'} at ${spokenTimecode(value)}`,
      'aria-disabled': disabled || undefined,
      className: `trim-thumb trim-thumb--${edge}`,
      style: { left: pct(value) },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const step = event.shiftKey ? 1000 : TIME_STEP_MS;
        let next: number | null = null;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = value - step;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = value + step;
        else if (event.key === 'PageDown') next = value - 5000;
        else if (event.key === 'PageUp') next = value + 5000;
        else if (event.key === 'Home') next = Math.max(min, view.fromMs);
        else if (event.key === 'End') next = Math.min(max, view.toMs);
        if (next === null) return;
        event.preventDefault();
        move(snapMs(next));
      },
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (disabled || event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        move(msAt(event.currentTarget.parentElement, event.clientX));
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      },
    };
  }

  const playheadVisible = playheadMs >= view.fromMs && playheadMs <= view.toMs;
  const hop = envelope?.hopMs ?? 1;
  return (
    <div className="trim-bar" data-disabled={disabled ? 'true' : 'false'}>
      <div
        className="trim-track"
        onPointerDown={(event) => {
          if (event.button === 0) onSeek(msAt(event.currentTarget, event.clientX));
        }}
      >
        {path ? (
          <svg
            className="trim-wave"
            viewBox={`${view.fromMs / hop} 0 ${span / hop} 100`}
            preserveAspectRatio="none"
            aria-hidden
            focusable="false"
          >
            <path d={path} />
          </svg>
        ) : (
          <span className="trim-wave trim-wave--empty" aria-hidden />
        )}
        <span className="trim-shade" style={{ left: 0, width: pct(startMs) }} aria-hidden />
        <span className="trim-shade" style={{ left: pct(endMs), right: 0 }} aria-hidden />
        <span
          className="trim-range"
          style={{ left: pct(startMs), right: `calc(100% - ${pct(endMs)})` }}
          aria-hidden
        />
        {playheadVisible ? (
          <span className="trim-playhead" style={{ left: pct(playheadMs) }} aria-hidden />
        ) : null}
        <div {...thumbProps('start')} />
        <div {...thumbProps('end')} />
      </div>
      <div className="trim-scale r-xs r-muted r-tabular" aria-hidden>
        <span>{formatTimecode(view.fromMs)}</span>
        <span>{formatTimecode(view.toMs)}</span>
      </div>
    </div>
  );
}
