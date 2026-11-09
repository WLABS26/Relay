import { describe, expect, it } from 'vitest';
import { evaluateSlot, type SlotContext } from './constraints';
import {
  DEFAULT_PUBLISHING_RULES,
  inQuietHours,
  publishingRulesSchema,
  type PublishingRules,
} from './rules';

const NOW = new Date('2026-11-09T08:00:00Z'); // Monday 09:00 in Berlin
const at = (iso: string) => new Date(iso);

function ctx(
  overrides: Partial<SlotContext> = {},
  rules: Partial<PublishingRules> = {},
): SlotContext {
  return {
    zone: 'Europe/Berlin',
    weekStart: 'monday',
    rules: { ...DEFAULT_PUBLISHING_RULES, ...rules },
    now: NOW,
    existing: [],
    ...overrides,
  };
}
const codes = (slot: Date, c: SlotContext) => evaluateSlot(slot, c).violations.map((v) => v.code);

describe('evaluateSlot', () => {
  it('accepts a slot inside a posting window with no neighbours', () => {
    expect(evaluateSlot(at('2026-11-10T09:00:00Z'), ctx())).toEqual({
      violations: [],
      warnings: [],
    });
  });

  it('refuses the past and slots inside the preparation lead time', () => {
    expect(codes(at('2026-11-09T07:59:00Z'), ctx())).toContain('schedule_in_past');
    const lead = evaluateSlot(at('2026-11-09T08:05:00Z'), ctx()).violations.find(
      (v) => v.code === 'lead_time_insufficient',
    );
    expect(lead?.details).toEqual({ earliestAt: '2026-11-09T08:10:00.000Z' });
  });

  it('waits for media that is still processing', () => {
    const c = ctx({ mediaReadyAt: at('2026-11-09T09:00:00Z') });
    expect(codes(at('2026-11-09T08:30:00Z'), c)).toContain('lead_time_insufficient');
    expect(codes(at('2026-11-09T09:00:00Z'), c)).not.toContain('lead_time_insufficient');
  });

  it('reports an exact collision as slot_conflict regardless of reservation order', () => {
    const slot = at('2026-11-10T09:00:00Z');
    const existing = [
      { postDestinationId: 'near', slotAt: at('2026-11-10T08:30:00Z') }, // inside the 2 h gap, listed first
      { postDestinationId: 'same', slotAt: slot },
    ];
    for (const order of [existing, [...existing].reverse()]) {
      const v = evaluateSlot(slot, ctx({ existing: order })).violations;
      expect(v.map((x) => x.code)).toEqual(['slot_conflict']);
      expect(v[0]!.details).toEqual({ conflictingPostDestinationId: 'same' });
    }
  });

  it('names the nearest neighbour when spacing is violated', () => {
    const existing = [
      { postDestinationId: 'far', slotAt: at('2026-11-10T07:30:00Z') },
      { postDestinationId: 'nearest', slotAt: at('2026-11-10T09:45:00Z') },
    ];
    const v = evaluateSlot(at('2026-11-10T09:00:00Z'), ctx({ existing })).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      code: 'min_gap_violation',
      details: { conflictingPostDestinationId: 'nearest' },
    });
    expect(v[0]!.message).toContain('2 h');
  });

  it('allows a neighbour exactly at the minimum gap, and none when the gap is zero', () => {
    const existing = [{ postDestinationId: 'x', slotAt: at('2026-11-10T07:00:00Z') }];
    expect(codes(at('2026-11-10T09:00:00Z'), ctx({ existing }))).toEqual([]);
    expect(codes(at('2026-11-10T07:30:00Z'), ctx({ existing }, { minGapMinutes: 0 }))).toEqual([]);
  });

  it('ignores the destination’s own reservation when rescheduling', () => {
    const existing = [{ postDestinationId: 'self', slotAt: at('2026-11-10T09:00:00Z') }];
    expect(
      codes(at('2026-11-10T09:15:00Z'), ctx({ existing, excludePostDestinationId: 'self' })),
    ).toEqual([]);
  });

  it('counts the daily cap in the page’s local calendar, not UTC', () => {
    // Los Angeles: 06:30Z on Nov 10 is still Nov 9 locally, so Nov 10 (local) has no posts yet.
    const c = ctx(
      {
        zone: 'America/Los_Angeles',
        existing: [{ postDestinationId: 'late', slotAt: at('2026-11-10T06:30:00Z') }],
      },
      { maxPerDay: 1, quietHours: [], postingWindows: [] },
    );
    expect(codes(at('2026-11-10T17:00:00Z'), c)).toEqual([]);
    expect(codes(at('2026-11-10T03:00:00Z'), c)).toContain('daily_cap_reached'); // Nov 9 local
  });

  it('counts the weekly cap from the configured week start', () => {
    const existing = [{ postDestinationId: 'sun', slotAt: at('2026-11-15T10:00:00Z') }]; // Sunday
    const rules = { maxPerWeek: 1, postingWindows: [] };
    const tuesday = at('2026-11-17T10:00:00Z');
    const saturday = at('2026-11-14T10:00:00Z');
    expect(codes(tuesday, ctx({ existing, weekStart: 'monday' }, rules))).toEqual([]); // Sunday belongs to the week before
    expect(codes(tuesday, ctx({ existing, weekStart: 'sunday' }, rules))).toContain(
      'weekly_cap_reached',
    );
    expect(codes(saturday, ctx({ existing, weekStart: 'monday' }, rules))).toContain(
      'weekly_cap_reached',
    );
  });

  it('enforces quiet hours that wrap past midnight', () => {
    const c = ctx({}, { postingWindows: [] });
    expect(codes(at('2026-11-10T22:30:00Z'), c)).toContain('quiet_hours'); // 23:30 local
    expect(codes(at('2026-11-11T05:59:00Z'), c)).toContain('quiet_hours'); // 06:59 local
    expect(codes(at('2026-11-11T06:00:00Z'), c)).not.toContain('quiet_hours'); // 07:00 local
  });

  it('warns (but allows) outside posting windows unless dispatching as soon as possible', () => {
    const slot = at('2026-11-10T13:00:00Z'); // 14:00 local Tuesday
    expect(evaluateSlot(slot, ctx()).warnings.map((w) => w.code)).toEqual([
      'outside_posting_window',
    ]);
    expect(evaluateSlot(slot, ctx({ asap: true })).warnings).toEqual([]);
    expect(evaluateSlot(slot, ctx()).violations).toEqual([]);
  });

  it('warns on a DST transition day so the user double-checks the local time', () => {
    const c = ctx({ now: at('2026-10-20T08:00:00Z') }, { postingWindows: [] });
    const w = evaluateSlot(at('2026-10-25T09:00:00Z'), c).warnings;
    expect(w.map((x) => x.code)).toEqual(['dst_transition_day']);
    expect(w[0]!.message).toContain('UTC+02:00 → UTC+01:00');
  });

  it('enforces campaign dates, rights expiry and the approval window', () => {
    const slot = at('2026-11-10T09:00:00Z');
    expect(codes(slot, ctx({ campaign: { startsOn: '2026-11-11' } }))).toEqual([
      'campaign_window_violation',
    ]);
    expect(codes(slot, ctx({ campaign: { endsOn: '2026-11-09' } }))).toEqual([
      'campaign_window_violation',
    ]);
    expect(
      codes(slot, ctx({ campaign: { startsOn: '2026-11-10', endsOn: '2026-11-10' } })),
    ).toEqual([]);
    expect(codes(slot, ctx({ rightsExpireAt: slot }))).toEqual(['rights_missing']); // expiry at the instant counts
    expect(codes(slot, ctx({ approvalWindow: { endsAt: at('2026-11-10T08:59:00Z') } }))).toEqual([
      'approval_window_violation',
    ]);
    expect(
      codes(slot, ctx({ approvalWindow: { startsAt: at('2026-11-10T09:00:00Z'), endsAt: slot } })),
    ).toEqual([]);
  });
});

describe('publishing rules', () => {
  it('rejects posting windows that end before they start or use 24-hour overflow', () => {
    const bad = {
      ...DEFAULT_PUBLISHING_RULES,
      postingWindows: [{ label: 'Bad', days: [1], start: '18:00', end: '09:00', priority: 3 }],
    };
    expect(publishingRulesSchema.safeParse(bad).success).toBe(false);
    const overflow = {
      ...DEFAULT_PUBLISHING_RULES,
      postingWindows: [{ label: 'Bad', days: [1], start: '09:00', end: '24:00', priority: 3 }],
    };
    expect(publishingRulesSchema.safeParse(overflow).success).toBe(false);
    expect(publishingRulesSchema.safeParse(DEFAULT_PUBLISHING_RULES).success).toBe(true);
  });

  it('treats an empty quiet-hours range as no quiet hours', () => {
    expect(inQuietHours(0, [{ start: '07:00', end: '07:00' }])).toBe(false);
    expect(inQuietHours(12 * 60, [{ start: '11:00', end: '13:00' }])).toBe(true);
  });
});
