import { describe, expect, it } from 'vitest';
import { evaluateSlot } from './constraints';
import { COLD_START_ALGORITHM, recommendSlots, type RecommendInput } from './recommend';
import { DEFAULT_PUBLISHING_RULES, type PublishingRules } from './rules';

const allDays = [1, 2, 3, 4, 5, 6, 7];

function input(
  overrides: Partial<RecommendInput> = {},
  rules: Partial<PublishingRules> = {},
): RecommendInput {
  return {
    zone: 'Europe/Berlin',
    weekStart: 'monday',
    rules: { ...DEFAULT_PUBLISHING_RULES, ...rules },
    now: new Date('2026-11-09T08:00:00Z'), // Monday 09:00 local
    existing: [],
    ...overrides,
  };
}

describe('recommendSlots (cold start)', () => {
  it('is deterministic and clearly labelled as cold start with no data', () => {
    const a = recommendSlots(input());
    const b = recommendSlots(input());
    expect(a).toEqual(b);
    expect(a.algorithmVersion).toBe(COLD_START_ALGORITHM);
    expect(a.fallbackReason).toBeNull();
    expect(a.explanation).toContain('No performance data was used');
    expect(a.suggestions.length).toBe(5);
    for (const s of a.suggestions) {
      expect(s).toMatchObject({
        coldStart: true,
        sampleSize: 0,
        dataOrigin: 'posting_windows',
        zone: 'Europe/Berlin',
      });
    }
  });

  it('only suggests slots that the scheduling constraints accept, in time order', () => {
    const base = input({
      existing: [{ postDestinationId: 'p1', slotAt: new Date('2026-11-10T08:00:00Z') }],
    });
    const { suggestions } = recommendSlots({ ...base, count: 12 });
    const times = suggestions.map((s) => Date.parse(s.slotAt));
    expect(times).toEqual([...times].sort((x, y) => x - y));
    for (const s of suggestions) {
      expect(evaluateSlot(new Date(s.slotAt), base).violations).toEqual([]);
    }
  });

  it('keeps suggestions apart by the minimum gap and spreads them across days', () => {
    const { suggestions } = recommendSlots(input({ count: 4 }));
    const days = new Set(suggestions.map((s) => s.civil.slice(0, 10)));
    expect(days.size).toBe(4);
    for (let i = 1; i < suggestions.length; i++) {
      expect(
        Date.parse(suggestions[i]!.slotAt) - Date.parse(suggestions[i - 1]!.slotAt),
      ).toBeGreaterThanOrEqual(120 * 60_000);
    }
  });

  it('never suggests before the lead time or before media is ready', () => {
    const mediaReadyAt = new Date('2026-11-12T00:00:00Z');
    const { suggestions } = recommendSlots(input({ mediaReadyAt }));
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions)
      expect(Date.parse(s.slotAt)).toBeGreaterThanOrEqual(mediaReadyAt.getTime());
  });

  it('never suggests a wall time that does not exist (spring forward)', () => {
    const { suggestions } = recommendSlots(
      input(
        { now: new Date('2026-03-28T12:00:00Z'), horizonDays: 3, count: 50, perDaySpread: 50 },
        {
          postingWindows: [
            { label: 'Night', days: allDays, start: '02:00', end: '04:00', priority: 3 },
          ],
          quietHours: [],
          minGapMinutes: 0,
          maxPerDay: 100,
        },
      ),
    );
    const onGapDay = suggestions.filter((s) => s.civil.startsWith('2026-03-29'));
    expect(onGapDay.map((s) => s.civil.slice(11))).toEqual(['03:00', '03:15', '03:30', '03:45']);
  });

  it('uses the first occurrence of a repeated wall time and says so (fall back)', () => {
    const { suggestions } = recommendSlots(
      input(
        { now: new Date('2026-10-24T12:00:00Z'), horizonDays: 2, count: 1 }, // Oct 24 (past 02:00) and Oct 25
        {
          postingWindows: [
            { label: 'Night', days: allDays, start: '02:00', end: '02:15', priority: 3 },
          ],
          quietHours: [],
        },
      ),
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      civil: '2026-10-25T02:00',
      offset: '+02:00',
      slotAt: '2026-10-25T00:00:00.000Z',
    });
    expect(suggestions[0]!.reasons.join(' ')).toContain('Clocks go back');
  });

  it('falls back to Relay’s default windows, and says so, when the page has none', () => {
    const r = recommendSlots(input({}, { postingWindows: [] }));
    expect(r.fallbackReason).toBe('no_posting_windows');
    expect(r.suggestions.every((s) => s.dataOrigin === 'default_windows')).toBe(true);
    expect(r.explanation).toContain('default windows');
  });

  it('returns no suggestions with a reason when nothing satisfies the rules', () => {
    const r = recommendSlots(input({}, { quietHours: [{ start: '00:00', end: '23:59' }] }));
    expect(r.suggestions).toEqual([]);
    expect(r.fallbackReason).toBe('no_slot_satisfies_constraints');
    expect(r.explanation).toContain('Pick a custom time');
  });
});
