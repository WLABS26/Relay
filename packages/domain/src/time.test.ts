import { describe, expect, it } from 'vitest';
import { isAppError } from './errors';
import {
  addDays,
  dstTransitionOn,
  formatHHmm,
  instantToZoned,
  isValidTimeZone,
  localDate,
  localWeekday,
  minutesOfDay,
  normalizeTimeZone,
  resolveCivilTime,
  selectInstant,
  startOfLocalDay,
  weekStartDate,
} from './time';

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('resolveCivilTime', () => {
  it('resolves an ordinary wall time to exactly one instant', () => {
    expect(resolveCivilTime('2026-07-01T12:00', 'Asia/Kolkata')).toEqual({
      kind: 'exact',
      value: {
        instant: '2026-07-01T06:30:00Z',
        civil: '2026-07-01T12:00',
        offset: '+05:30',
        zone: 'Asia/Kolkata',
      },
    });
  });

  it.each([
    // zone, wall time in the spring-forward gap, first valid wall time after it
    ['Europe/Berlin', '2026-03-29T02:30', '2026-03-29T03:30'],
    ['America/New_York', '2026-03-08T02:30', '2026-03-08T03:30'],
    ['Australia/Lord_Howe', '2026-10-04T02:15', '2026-10-04T02:45'], // 30-minute DST
    ['America/Santiago', '2026-09-06T00:30', '2026-09-06T01:30'], // the gap is at midnight
  ])('reports %s %s as nonexistent and suggests the shifted time', (zone, civil, after) => {
    const r = resolveCivilTime(civil, zone);
    expect(r.kind).toBe('nonexistent');
    if (r.kind === 'nonexistent') expect(r.after.civil).toBe(after);
  });

  it.each([
    ['Europe/Berlin', '2026-10-25T02:30', '+02:00', '+01:00'],
    ['America/New_York', '2026-11-01T01:30', '-04:00', '-05:00'],
    ['Australia/Lord_Howe', '2026-04-05T01:45', '+11:00', '+10:30'],
  ])(
    'reports %s %s as ambiguous with both offsets, earlier first',
    (zone, civil, earlier, later) => {
      const r = resolveCivilTime(civil, zone);
      expect(r.kind).toBe('ambiguous');
      if (r.kind !== 'ambiguous') return;
      expect([r.earlier.offset, r.later.offset]).toEqual([earlier, later]);
      expect(r.earlier.civil).toBe(civil);
      expect(r.later.civil).toBe(civil);
      expect(Date.parse(r.later.instant) - Date.parse(r.earlier.instant)).toBeGreaterThan(0);
    },
  );

  it('treats the first instant after a fold as exact', () => {
    expect(resolveCivilTime('2026-10-25T03:00', 'Europe/Berlin').kind).toBe('exact');
  });

  it('rejects malformed and impossible calendar values', () => {
    expect(errorOf(() => resolveCivilTime('2026-10-25 03:00', 'Europe/Berlin')).code).toBe(
      'validation_failed',
    );
    expect(errorOf(() => resolveCivilTime('2026-02-30T10:00', 'Europe/Berlin')).code).toBe(
      'validation_failed',
    );
    expect(errorOf(() => resolveCivilTime('2026-01-01T24:00', 'Europe/Berlin')).code).toBe(
      'validation_failed',
    );
  });
});

describe('selectInstant', () => {
  it('never guesses an ambiguous time: it asks, listing both instants', () => {
    const error = errorOf(() => selectInstant('2026-10-25T02:30', 'Europe/Berlin'));
    expect(error.code).toBe('ambiguous_local_time');
    expect(error.details?.options).toEqual([
      { instant: '2026-10-25T00:30:00Z', offset: '+02:00' },
      { instant: '2026-10-25T01:30:00Z', offset: '+01:00' },
    ]);
  });

  it('uses the explicit offset the user chose, and refuses one that does not apply', () => {
    expect(selectInstant('2026-10-25T02:30', 'Europe/Berlin', '+01:00').instant).toBe(
      '2026-10-25T01:30:00Z',
    );
    expect(selectInstant('2026-10-25T02:30', 'Europe/Berlin', '+02:00').instant).toBe(
      '2026-10-25T00:30:00Z',
    );
    expect(errorOf(() => selectInstant('2026-10-25T02:30', 'Europe/Berlin', '+05:00')).code).toBe(
      'ambiguous_local_time',
    );
    expect(errorOf(() => selectInstant('2026-07-01T12:00', 'Europe/Berlin', '+01:00')).code).toBe(
      'validation_failed',
    );
  });

  it('applies a page rule for folds only when one is set', () => {
    expect(selectInstant('2026-11-01T01:30', 'America/New_York', undefined, 'earlier').offset).toBe(
      '-04:00',
    );
    expect(selectInstant('2026-11-01T01:30', 'America/New_York', undefined, 'later').offset).toBe(
      '-05:00',
    );
  });

  it('refuses a nonexistent time and offers the next valid one', () => {
    const error = errorOf(() => selectInstant('2026-03-29T02:30', 'Europe/Berlin'));
    expect(error.code).toBe('nonexistent_local_time');
    expect(error.message).toContain('03:30');
    expect((error.details?.suggestion as { civil: string }).civil).toBe('2026-03-29T03:30');
  });
});

describe('zone helpers', () => {
  it('validates and canonicalises IANA zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(normalizeTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(errorOf(() => normalizeTimeZone('Nowhere/City')).code).toBe('validation_failed');
  });

  it('computes local dates and weekdays in the zone, not in UTC', () => {
    // 23:30 UTC on Monday is already Tuesday morning in Tokyo.
    expect(instantToZoned('2026-11-09T23:30:00Z', 'Asia/Tokyo').civil).toBe('2026-11-10T08:30');
    expect(localDate('2026-11-09T23:30:00Z', 'Asia/Tokyo')).toBe('2026-11-10');
    expect(localWeekday('2026-11-09T23:30:00Z', 'Asia/Tokyo')).toBe(2);
    expect(localDate('2026-11-10T06:30:00Z', 'America/Los_Angeles')).toBe('2026-11-09');
  });

  it('finds the start of the local week for either week start', () => {
    expect(weekStartDate('2026-11-11', 'monday')).toBe('2026-11-09');
    expect(weekStartDate('2026-11-11', 'sunday')).toBe('2026-11-08');
    expect(weekStartDate('2026-11-08', 'monday')).toBe('2026-11-02'); // a Sunday belongs to the previous ISO week
    expect(weekStartDate('2026-11-08', 'sunday')).toBe('2026-11-08');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('starts a day at its first valid instant, even when local midnight does not exist', () => {
    expect(startOfLocalDay('2026-03-29', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(startOfLocalDay('2026-09-06', 'America/Santiago').toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
  });

  it('flags DST transition days with the offsets on either side', () => {
    expect(dstTransitionOn('2026-03-29', 'Europe/Berlin')).toEqual({
      from: '+01:00',
      to: '+02:00',
    });
    expect(dstTransitionOn('2026-10-25', 'Europe/Berlin')).toEqual({
      from: '+02:00',
      to: '+01:00',
    });
    expect(dstTransitionOn('2026-10-04', 'Australia/Lord_Howe')).toEqual({
      from: '+10:30',
      to: '+11:00',
    });
    expect(dstTransitionOn('2026-06-01', 'Europe/Berlin')).toBeNull();
    expect(dstTransitionOn('2026-03-29', 'Asia/Kolkata')).toBeNull();
  });

  it('round-trips minutes of day', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('23:59')).toBe(1439);
    expect(formatHHmm(minutesOfDay('07:05'))).toBe('07:05');
  });
});
