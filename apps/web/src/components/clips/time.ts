/**
 * Timecodes for the clip screens. Everything is milliseconds on the source timeline; the
 * interface works in tenths of a second, which is finer than one output frame is long.
 */

export const TIME_STEP_MS = 100;

const pad = (n: number) => String(n).padStart(2, '0');

/** `mm:ss.d`, or `h:mm:ss.d` from one hour. */
export function formatTimecode(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / TIME_STEP_MS));
  const totalSeconds = Math.floor(tenths / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const tail = `${pad(totalSeconds % 60)}.${tenths % 10}`;
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${tail}`
    : `${pad(minutes)}:${tail}`;
}

/** The same instant in words a screen reader reads well: "1 minute 23.4 seconds". */
export function spokenTimecode(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / TIME_STEP_MS));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  const secondsText = `${seconds} second${seconds === 1 ? '' : 's'}`;
  return minutes > 0 ? `${minutes} minute${minutes === 1 ? '' : 's'} ${secondsText}` : secondsText;
}

/** A length such as "18.5 s" or "1 min 4 s". */
export function formatLength(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / TIME_STEP_MS));
  if (tenths < 600) return `${tenths / 10} s`;
  const seconds = Math.round(tenths / 10);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * Accepts `83.4`, `1:23.4` and `0:01:23.4` (a comma works as the decimal mark). Returns whole
 * milliseconds, or null when the text is not a time.
 */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().replace(',', '.').split(':');
  if (parts.length === 0 || parts.length > 3) return null;
  let seconds = 0;
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (!(last ? /^\d+(\.\d{1,3})?$/ : /^\d+$/).test(part)) return null;
    const value = Number(part);
    if (!last && index > 0 && value >= 60) return null;
    if (last && parts.length > 1 && value >= 60) return null;
    seconds = seconds * 60 + value;
  }
  const ms = Math.round(seconds * 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

export const snapMs = (ms: number): number => Math.round(ms / TIME_STEP_MS) * TIME_STEP_MS;

export const clampMs = (ms: number, min: number, max: number): number =>
  Math.min(Math.max(ms, min), Math.max(min, max));
