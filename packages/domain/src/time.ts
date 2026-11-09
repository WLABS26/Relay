import { Temporal } from 'temporal-polyfill';
import { AppError } from './errors';

/**
 * Civil-time handling. Relay persists UTC instants, but people schedule in a page's IANA
 * zone. Converting a wall-clock time can be:
 *   - exact: one instant;
 *   - ambiguous (DST fall-back fold): the wall time happens twice, with two offsets;
 *   - nonexistent (DST spring-forward gap): the wall time never happens.
 * Ambiguous and nonexistent times are never silently resolved: callers must pass an explicit
 * offset (ambiguous) or pick a valid time (nonexistent), unless a page rule documents a
 * deterministic choice.
 */

export type WeekStart = 'monday' | 'sunday';

/** "YYYY-MM-DDTHH:mm" (seconds optional) local wall-clock time without zone. */
export type CivilDateTime = string;

export interface ZonedInstant {
  /** UTC instant, ISO 8601 with Z. */
  instant: string;
  /** Wall-clock in the zone, "YYYY-MM-DDTHH:mm". */
  civil: CivilDateTime;
  /** Offset at that instant, e.g. "+01:00". */
  offset: string;
  zone: string;
}

export type CivilResolution =
  | { kind: 'exact'; value: ZonedInstant }
  | { kind: 'ambiguous'; earlier: ZonedInstant; later: ZonedInstant }
  | { kind: 'nonexistent'; before: ZonedInstant; after: ZonedInstant };

const CIVIL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    Temporal.Now.zonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

/** Case-normalised zone identifier (e.g. "europe/berlin" → "Europe/Berlin"). */
export function normalizeTimeZone(zone: string): string {
  if (!isValidTimeZone(zone)) {
    throw new AppError('validation_failed', `Unknown time zone "${zone}"`, {
      fieldErrors: { timezone: ['Use an IANA time zone such as Europe/Berlin'] },
    });
  }
  return Temporal.Now.zonedDateTimeISO(zone).timeZoneId;
}

function toZonedInstant(zdt: Temporal.ZonedDateTime): ZonedInstant {
  return {
    instant: zdt.toInstant().toString({ smallestUnit: 'second' }),
    civil: zdt.toPlainDateTime().toString({ smallestUnit: 'minute' }),
    offset: zdt.offset,
    zone: zdt.timeZoneId,
  };
}

function parseCivil(civil: CivilDateTime): Temporal.PlainDateTime {
  if (!CIVIL_RE.test(civil)) {
    throw new AppError('validation_failed', 'Expected a local time like 2026-11-12T09:30', {
      fieldErrors: { localTime: ['Expected YYYY-MM-DDTHH:mm'] },
    });
  }
  try {
    return Temporal.PlainDateTime.from(civil, { overflow: 'reject' });
  } catch {
    throw new AppError('validation_failed', `"${civil}" is not a valid calendar date and time`, {
      fieldErrors: { localTime: ['Not a valid date and time'] },
    });
  }
}

/** Classify how a wall-clock time maps to instants in a zone. */
export function resolveCivilTime(civil: CivilDateTime, zone: string): CivilResolution {
  const pdt = parseCivil(civil);
  const earlier = pdt.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = pdt.toZonedDateTime(zone, { disambiguation: 'later' });
  if (earlier.epochNanoseconds === later.epochNanoseconds) {
    return { kind: 'exact', value: toZonedInstant(earlier) };
  }
  const earlierMatches = Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), pdt) === 0;
  const laterMatches = Temporal.PlainDateTime.compare(later.toPlainDateTime(), pdt) === 0;
  if (earlierMatches && laterMatches) {
    return { kind: 'ambiguous', earlier: toZonedInstant(earlier), later: toZonedInstant(later) };
  }
  // Spring-forward gap: `earlier` lands before the gap, `later` after it.
  return { kind: 'nonexistent', before: toZonedInstant(earlier), after: toZonedInstant(later) };
}

export type AmbiguityPolicy = 'ask' | 'earlier' | 'later';

/**
 * Resolve a wall-clock time to exactly one instant or throw an actionable error.
 * @param offset explicit offset chosen by the user for an ambiguous time (e.g. "+01:00").
 * @param policy page rule for folds when no offset is given; "ask" (default) never guesses.
 */
export function selectInstant(
  civil: CivilDateTime,
  zone: string,
  offset?: string,
  policy: AmbiguityPolicy = 'ask',
): ZonedInstant {
  const resolution = resolveCivilTime(civil, zone);
  switch (resolution.kind) {
    case 'exact':
      if (offset && offset !== resolution.value.offset) {
        throw new AppError(
          'validation_failed',
          `${civil} in ${zone} has offset ${resolution.value.offset}, not ${offset}`,
          { fieldErrors: { offset: [`Expected ${resolution.value.offset}`] } },
        );
      }
      return resolution.value;
    case 'ambiguous': {
      if (offset) {
        const match = [resolution.earlier, resolution.later].find((o) => o.offset === offset);
        if (match) return match;
      } else if (policy !== 'ask') {
        return policy === 'earlier' ? resolution.earlier : resolution.later;
      }
      throw new AppError(
        'ambiguous_local_time',
        `${civil.slice(11, 16)} happens twice on ${civil.slice(0, 10)} in ${zone} because clocks go back. Choose which one.`,
        {
          details: {
            options: [
              { instant: resolution.earlier.instant, offset: resolution.earlier.offset },
              { instant: resolution.later.instant, offset: resolution.later.offset },
            ],
          },
        },
      );
    }
    case 'nonexistent':
      throw new AppError(
        'nonexistent_local_time',
        `${civil.slice(11, 16)} does not exist on ${civil.slice(0, 10)} in ${zone} because clocks go forward. Choose another time, for example ${resolution.after.civil.slice(11, 16)}.`,
        { details: { suggestion: resolution.after } },
      );
  }
}

/** Describe a UTC instant in a zone. */
export function instantToZoned(instant: Date | string, zone: string): ZonedInstant {
  const inst = Temporal.Instant.from(typeof instant === 'string' ? instant : instant.toISOString());
  return toZonedInstant(inst.toZonedDateTimeISO(zone));
}

/** Local calendar date ("YYYY-MM-DD") of an instant in a zone. */
export function localDate(instant: Date | string, zone: string): string {
  return instantToZoned(instant, zone).civil.slice(0, 10);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of an instant in a zone. */
export function localWeekday(instant: Date | string, zone: string): number {
  const inst = Temporal.Instant.from(typeof instant === 'string' ? instant : instant.toISOString());
  return inst.toZonedDateTimeISO(zone).dayOfWeek;
}

/** Start date ("YYYY-MM-DD") of the local week containing `date`, honouring week start. */
export function weekStartDate(date: string, weekStart: WeekStart): string {
  const d = Temporal.PlainDate.from(date);
  const offset = weekStart === 'monday' ? d.dayOfWeek - 1 : d.dayOfWeek % 7;
  return d.subtract({ days: offset }).toString();
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function isoWeekdayOf(date: string): number {
  return Temporal.PlainDate.from(date).dayOfWeek;
}

/** UTC instant for local midnight at the start of `date` in `zone` (handles midnight gaps). */
export function startOfLocalDay(date: string, zone: string): Date {
  const zdt = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: zone });
  return new Date(Number(zdt.epochMilliseconds));
}

/** Minutes since local midnight for "HH:mm". */
export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

export function formatHHmm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Offsets (minutes) at the start and end of a local day — differ on DST change days. */
export function dstTransitionOn(date: string, zone: string): { from: string; to: string } | null {
  const start = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: zone });
  const end = start.add({ days: 1 });
  return start.offset === end.offset ? null : { from: start.offset, to: end.offset };
}
