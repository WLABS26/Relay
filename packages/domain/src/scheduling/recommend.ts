import { addDays, formatHHmm, isoWeekdayOf, localDate, minutesOfDay, resolveCivilTime } from '../time';
import { evaluateSlot, type SlotContext } from './constraints';
import { DEFAULT_POSTING_WINDOWS, windowsFor, type PostingWindow } from './rules';

/**
 * Cold-start slot recommender (algorithm "cold-start-windows@1").
 *
 * Uses only the page's editable posting windows, its pacing rules and the account's existing
 * reservations — no performance data and no provider data. It never writes anything: callers
 * must schedule a suggestion explicitly. Suggestions are labelled as cold-start with a sample
 * size of zero so the UI never implies a data-backed "best time".
 */

export const COLD_START_ALGORITHM = 'cold-start-windows@1';

export interface RecommendInput extends Omit<SlotContext, 'asap'> {
  /** Earliest instant to consider (defaults to now + lead). */
  from?: Date;
  horizonDays?: number;
  count?: number;
  /** Prefer at most this many suggestions per local day before doubling up. */
  perDaySpread?: number;
}

export interface SlotSuggestion {
  slotAt: string;
  civil: string;
  offset: string;
  zone: string;
  windowLabel: string;
  score: number;
  reasons: string[];
  dataOrigin: 'posting_windows' | 'default_windows';
  coldStart: true;
  sampleSize: 0;
}

export interface RecommendResult {
  algorithmVersion: string;
  suggestions: SlotSuggestion[];
  /** Set when results fall back or are empty; shown to the user verbatim. */
  fallbackReason: 'no_posting_windows' | 'no_slot_satisfies_constraints' | null;
  explanation: string;
}

interface Candidate {
  slotAt: Date;
  civil: string;
  offset: string;
  window: PostingWindow;
  day: string;
  score: number;
  reasons: string[];
}

export function recommendSlots(input: RecommendInput): RecommendResult {
  const count = input.count ?? 5;
  const horizonDays = input.horizonDays ?? 14;
  const usingDefaults = input.rules.postingWindows.length === 0;
  const windows = usingDefaults ? DEFAULT_POSTING_WINDOWS : input.rules.postingWindows;
  const rules = usingDefaults ? { ...input.rules, postingWindows: windows } : input.rules;
  const ctx: SlotContext = { ...input, rules };
  const step = rules.slotGranularityMinutes;

  const startAt = new Date(
    Math.max(
      input.from?.getTime() ?? 0,
      input.now.getTime() + rules.leadMinutes * 60_000,
      input.mediaReadyAt?.getTime() ?? 0,
    ),
  );
  const firstDay = localDate(startAt, input.zone);
  const existingPerDay = new Map<string, number>();
  for (const e of input.existing) {
    if (e.postDestinationId === input.excludePostDestinationId) continue;
    const d = localDate(e.slotAt, input.zone);
    existingPerDay.set(d, (existingPerDay.get(d) ?? 0) + 1);
  }

  const candidates: Candidate[] = [];
  for (let offsetDays = 0; offsetDays < horizonDays; offsetDays++) {
    const day = addDays(firstDay, offsetDays);
    const weekday = isoWeekdayOf(day);
    for (const window of windowsFor(weekday, windows)) {
      for (let m = minutesOfDay(window.start); m < minutesOfDay(window.end); m += step) {
        const civil = `${day}T${formatHHmm(m)}`;
        const resolution = resolveCivilTime(civil, input.zone);
        // Never suggest a wall time that does not exist; for a fold use the first occurrence
        // and say so, so the user is never surprised by an hour shift.
        if (resolution.kind === 'nonexistent') continue;
        const zoned = resolution.kind === 'exact' ? resolution.value : resolution.earlier;
        const slotAt = new Date(zoned.instant);
        if (slotAt.getTime() < startAt.getTime()) continue;
        const { violations } = evaluateSlot(slotAt, ctx);
        if (violations.length > 0) continue;

        const sameDay = existingPerDay.get(day) ?? 0;
        const reasons = [`Inside your “${window.label}” posting window`];
        if (sameDay === 0) reasons.push('No other posts on this account that day');
        else reasons.push(`${sameDay} other post${sameDay === 1 ? '' : 's'} that day; spacing rules respected`);
        if (rules.minGapMinutes > 0) reasons.push(`Keeps the ${rules.minGapMinutes}-minute minimum gap`);
        if (resolution.kind === 'ambiguous') {
          reasons.push(`Clocks go back that night; this is the first ${civil.slice(11, 16)} (${zoned.offset})`);
        }
        // Prefer high-priority windows, lightly loaded days and sooner dates; earliest minute
        // in a window breaks ties. Fully deterministic for identical input.
        const score =
          window.priority * 10 - sameDay * 4 - offsetDays * 0.5 - (m - minutesOfDay(window.start)) / 600;
        candidates.push({
          slotAt,
          civil: zoned.civil,
          offset: zoned.offset,
          window,
          day,
          score: Math.round(score * 100) / 100,
          reasons,
        });
      }
    }
  }

  // Spread suggestions across days: take the best slot per day first, then fill.
  const spread = input.perDaySpread ?? 1;
  const sorted = [...candidates].sort(
    (a, b) => b.score - a.score || a.slotAt.getTime() - b.slotAt.getTime(),
  );
  const chosen: Candidate[] = [];
  const perDay = new Map<string, number>();
  for (const pass of [spread, Number.POSITIVE_INFINITY]) {
    for (const c of sorted) {
      if (chosen.length >= count) break;
      if (chosen.includes(c)) continue;
      if ((perDay.get(c.day) ?? 0) >= pass) continue;
      // Suggestions must also respect min-gap among themselves.
      const tooClose = chosen.some(
        (o) => Math.abs(o.slotAt.getTime() - c.slotAt.getTime()) < rules.minGapMinutes * 60_000,
      );
      if (tooClose) continue;
      chosen.push(c);
      perDay.set(c.day, (perDay.get(c.day) ?? 0) + 1);
    }
  }
  chosen.sort((a, b) => a.slotAt.getTime() - b.slotAt.getTime());

  const suggestions: SlotSuggestion[] = chosen.map((c) => ({
    slotAt: c.slotAt.toISOString(),
    civil: c.civil,
    offset: c.offset,
    zone: input.zone,
    windowLabel: c.window.label,
    score: c.score,
    reasons: c.reasons,
    dataOrigin: usingDefaults ? 'default_windows' : 'posting_windows',
    coldStart: true,
    sampleSize: 0,
  }));

  const fallbackReason =
    suggestions.length === 0 ? 'no_slot_satisfies_constraints' : usingDefaults ? 'no_posting_windows' : null;
  const explanation =
    suggestions.length === 0
      ? `No time in the next ${horizonDays} days satisfies this page's posting windows, quiet hours and pacing limits. Pick a custom time or adjust the publishing rules.`
      : usingDefaults
        ? 'Cold start: this page has no posting windows yet, so these follow Relay’s default windows. No performance data was used.'
        : 'Cold start: based on this page’s posting windows and pacing rules. No performance data was used yet.';

  return { algorithmVersion: COLD_START_ALGORITHM, suggestions, fallbackReason, explanation };
}
