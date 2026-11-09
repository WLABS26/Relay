import type { ErrorCode } from '../errors';
import {
  dstTransitionOn,
  instantToZoned,
  isoWeekdayOf,
  localDate,
  minutesOfDay,
  weekStartDate,
  type WeekStart,
} from '../time';
import { inQuietHours, windowsFor, type PublishingRules } from './rules';

/**
 * Pure slot-constraint evaluation. The scheduling transaction calls this while holding the
 * social-account row lock, with the account's committed reservations loaded inside the same
 * transaction, so two concurrent schedules for one account cannot both pass.
 */

export interface ExistingSlot {
  postDestinationId: string;
  slotAt: Date;
}

export interface SlotContext {
  zone: string;
  weekStart: WeekStart;
  rules: PublishingRules;
  now: Date;
  /** Reservations on the same connected account (active and consumed). */
  existing: ExistingSlot[];
  /** Ignore this destination's own current reservation (reschedule). */
  excludePostDestinationId?: string;
  /** Earliest time media is ready (e.g. still processing). */
  mediaReadyAt?: Date;
  /** Campaign dates are civil dates in the page zone (inclusive). */
  campaign?: { startsOn?: string | null; endsOn?: string | null } | null;
  rightsExpireAt?: Date | null;
  approvalWindow?: { startsAt?: Date | null; endsAt?: Date | null } | null;
  /** Dispatch "as soon as possible" skips posting-window warnings. */
  asap?: boolean;
}

export interface SlotViolation {
  code: Extract<
    ErrorCode,
    | 'min_gap_violation'
    | 'daily_cap_reached'
    | 'weekly_cap_reached'
    | 'quiet_hours'
    | 'schedule_in_past'
    | 'lead_time_insufficient'
    | 'campaign_window_violation'
    | 'rights_missing'
    | 'approval_window_violation'
    | 'slot_conflict'
  >;
  message: string;
  details?: Record<string, unknown>;
}

export interface SlotWarning {
  code: 'outside_posting_window' | 'dst_transition_day';
  message: string;
}

export interface SlotEvaluation {
  violations: SlotViolation[];
  warnings: SlotWarning[];
}

const MINUTE = 60_000;

function fmtMinutes(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} min`;
}

export function evaluateSlot(slotAt: Date, ctx: SlotContext): SlotEvaluation {
  const violations: SlotViolation[] = [];
  const warnings: SlotWarning[] = [];
  const { rules, zone } = ctx;
  const others = ctx.existing.filter((e) => e.postDestinationId !== ctx.excludePostDestinationId);

  // 1. Not in the past, and leave the lead time for preparation.
  const earliest = new Date(
    Math.max(ctx.now.getTime() + rules.leadMinutes * MINUTE, ctx.mediaReadyAt?.getTime() ?? 0),
  );
  if (slotAt.getTime() < ctx.now.getTime()) {
    violations.push({ code: 'schedule_in_past', message: 'That time has already passed.' });
  } else if (slotAt.getTime() < earliest.getTime()) {
    violations.push({
      code: 'lead_time_insufficient',
      message: `Leave at least ${fmtMinutes(rules.leadMinutes)} before publishing so media can be prepared.`,
      details: { earliestAt: earliest.toISOString() },
    });
  }

  // 2. Exact-slot conflict and minimum spacing on the same account. An exact collision wins
  // over a spacing problem whatever order reservations load in, and spacing names the
  // nearest neighbour, so the message is stable and actionable.
  const exact = others.find((o) => o.slotAt.getTime() === slotAt.getTime());
  if (exact) {
    violations.push({
      code: 'slot_conflict',
      message: 'Another post is already scheduled on this account at exactly that time.',
      details: { conflictingPostDestinationId: exact.postDestinationId },
    });
  } else if (rules.minGapMinutes > 0) {
    const gapMs = rules.minGapMinutes * MINUTE;
    let nearest: ExistingSlot | null = null;
    let nearestDelta = Number.POSITIVE_INFINITY;
    for (const other of others) {
      const delta = Math.abs(other.slotAt.getTime() - slotAt.getTime());
      if (delta < gapMs && delta < nearestDelta) {
        nearest = other;
        nearestDelta = delta;
      }
    }
    if (nearest) {
      violations.push({
        code: 'min_gap_violation',
        message: `Posts on this account must be at least ${fmtMinutes(rules.minGapMinutes)} apart.`,
        details: {
          conflictingPostDestinationId: nearest.postDestinationId,
          conflictingAt: nearest.slotAt.toISOString(),
        },
      });
    }
  }

  // 3. Daily and weekly caps in the page's local calendar.
  const day = localDate(slotAt, zone);
  const sameDay = others.filter((o) => localDate(o.slotAt, zone) === day).length;
  if (sameDay >= rules.maxPerDay) {
    violations.push({
      code: 'daily_cap_reached',
      message: `This account already has ${sameDay} post${sameDay === 1 ? '' : 's'} on ${day} (limit ${rules.maxPerDay}).`,
    });
  }
  const week = weekStartDate(day, ctx.weekStart);
  const sameWeek = others.filter(
    (o) => weekStartDate(localDate(o.slotAt, zone), ctx.weekStart) === week,
  ).length;
  if (sameWeek >= rules.maxPerWeek) {
    violations.push({
      code: 'weekly_cap_reached',
      message: `This account already has ${sameWeek} posts in the week of ${week} (limit ${rules.maxPerWeek}).`,
    });
  }

  // 4. Quiet hours (hard) and posting windows (soft).
  const zoned = instantToZoned(slotAt, zone);
  const minute = minutesOfDay(zoned.civil.slice(11, 16));
  if (inQuietHours(minute, rules.quietHours)) {
    violations.push({
      code: 'quiet_hours',
      message: `${zoned.civil.slice(11, 16)} is inside this page's quiet hours.`,
    });
  }
  if (!ctx.asap) {
    const inWindow = windowsFor(isoWeekdayOf(day), rules.postingWindows).some(
      (w) => minute >= minutesOfDay(w.start) && minute < minutesOfDay(w.end),
    );
    if (rules.postingWindows.length > 0 && !inWindow) {
      warnings.push({
        code: 'outside_posting_window',
        message: 'This time is outside the page’s preferred posting windows.',
      });
    }
  }
  const transition = dstTransitionOn(day, zone);
  if (transition) {
    warnings.push({
      code: 'dst_transition_day',
      message: `Clocks change on ${day} in ${zone} (UTC${transition.from} → UTC${transition.to}). Check this is the local time you meant.`,
    });
  }

  // 5. Campaign dates, rights expiry, approval window.
  if (ctx.campaign?.startsOn && day < ctx.campaign.startsOn) {
    violations.push({
      code: 'campaign_window_violation',
      message: `The campaign starts on ${ctx.campaign.startsOn}.`,
    });
  }
  if (ctx.campaign?.endsOn && day > ctx.campaign.endsOn) {
    violations.push({
      code: 'campaign_window_violation',
      message: `The campaign ended on ${ctx.campaign.endsOn}.`,
    });
  }
  if (ctx.rightsExpireAt && slotAt.getTime() >= ctx.rightsExpireAt.getTime()) {
    violations.push({
      code: 'rights_missing',
      message: 'Publishing rights for this media expire before that time.',
      details: { rightsExpireAt: ctx.rightsExpireAt.toISOString() },
    });
  }
  const w = ctx.approvalWindow;
  if (
    w &&
    ((w.startsAt && slotAt.getTime() < w.startsAt.getTime()) ||
      (w.endsAt && slotAt.getTime() > w.endsAt.getTime()))
  ) {
    violations.push({
      code: 'approval_window_violation',
      message: 'That time is outside the approved window. Request a new approval to use it.',
    });
  }

  return { violations, warnings };
}
