/**
 * Localisation-ready formatting. Everything goes through Intl with an explicit IANA zone, so
 * times always show in the page (or workspace) zone the user chose — never the browser's.
 * Plain English copy for now; strings are centralised for later localisation.
 */

export const LOCALE = 'en-GB';

export function formatDateTime(
  value: Date | string | null | undefined,
  zone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...options,
  }).format(d);
}

export function formatTime(value: Date | string, zone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(typeof value === 'string' ? new Date(value) : value);
}

export function formatDay(isoDate: string): string {
  // isoDate is a civil date; format at noon UTC so no zone can shift the day.
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

export function formatDayShort(isoDate: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

export function zoneLabel(zone: string, at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat(LOCALE, { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return `${zone.replace(/_/g, ' ')} (${part?.value ?? zone})`;
}

export function formatNumber(
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(LOCALE, options).format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${formatNumber(v, { maximumFractionDigits: 1 })} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

export function relativeTime(value: Date | string, now: Date = new Date()): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const diff = (d.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
