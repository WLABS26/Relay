import { z } from 'zod';
import { minutesOfDay } from '../time';

/**
 * Page publishing rules. Stored as an immutable, versioned policy revision per page; every
 * schedule and recommendation records the revision it used.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm');

export const postingWindowSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    /** ISO weekdays: 1 = Monday … 7 = Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: hhmm,
    end: hhmm,
    /** 1 (low) … 5 (high): editorial preference when ranking cold-start slots. */
    priority: z.number().int().min(1).max(5).default(3),
  })
  .refine((w) => minutesOfDay(w.start) < minutesOfDay(w.end), {
    message: 'Window must end after it starts (same day)',
    path: ['end'],
  });

export const quietHoursSchema = z.object({ start: hhmm, end: hhmm });

export const publishingRulesSchema = z.object({
  postingWindows: z.array(postingWindowSchema).max(28),
  /** Minimum spacing between two posts on the same connected account. */
  minGapMinutes: z.number().int().min(0).max(7 * 24 * 60),
  maxPerDay: z.number().int().min(1).max(100),
  maxPerWeek: z.number().int().min(1).max(700),
  /** Local times when nothing may be dispatched; may wrap past midnight. */
  quietHours: z.array(quietHoursSchema).max(4),
  /** Minimum time between scheduling and dispatch (media readiness / provider prep). */
  leadMinutes: z.number().int().min(0).max(24 * 60),
  /** How late a dispatch may start before it is routed to review instead. */
  lateGraceMinutes: z.number().int().min(0).max(24 * 60),
  slotGranularityMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]),
  /** What to do when a chosen local time happens twice (DST fall-back). */
  ambiguousTimePolicy: z.enum(['ask', 'earlier', 'later']),
  /** Supervised automation is off by default and only owners/admins can change it (M6). */
  automation: z.object({
    mode: z.enum(['off', 'suggest', 'queue_for_approval']),
  }),
});

export type PostingWindow = z.infer<typeof postingWindowSchema>;
export type PublishingRules = z.infer<typeof publishingRulesSchema>;

export const DEFAULT_POSTING_WINDOWS: PostingWindow[] = [
  { label: 'Weekday mornings', days: [1, 2, 3, 4, 5], start: '09:00', end: '11:00', priority: 4 },
  { label: 'Weekday evenings', days: [1, 2, 3, 4, 5], start: '17:00', end: '19:30', priority: 3 },
  { label: 'Weekend late morning', days: [6, 7], start: '10:00', end: '12:00', priority: 2 },
];

export const DEFAULT_PUBLISHING_RULES: PublishingRules = {
  postingWindows: DEFAULT_POSTING_WINDOWS,
  minGapMinutes: 120,
  maxPerDay: 3,
  maxPerWeek: 14,
  quietHours: [{ start: '23:00', end: '07:00' }],
  leadMinutes: 10,
  lateGraceMinutes: 15,
  slotGranularityMinutes: 15,
  ambiguousTimePolicy: 'ask',
  automation: { mode: 'off' },
};

/** True if minute-of-day `m` falls inside any quiet-hours range (ranges may wrap midnight). */
export function inQuietHours(minuteOfDay: number, quietHours: PublishingRules['quietHours']): boolean {
  return quietHours.some(({ start, end }) => {
    const s = minutesOfDay(start);
    const e = minutesOfDay(end);
    if (s === e) return false;
    return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
  });
}

export function windowsFor(weekday: number, windows: PostingWindow[]): PostingWindow[] {
  return windows.filter((w) => w.days.includes(weekday));
}
