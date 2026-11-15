import { describe, expect, it } from 'vitest';
import { demoDaytime } from './seed';

const berlinHour = (d: Date) =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(d),
  );

describe('demoDaytime', () => {
  it('leaves a daytime instant alone', () => {
    const noon = new Date('2026-11-15T11:00:00Z'); // 12:00 Berlin
    expect(demoDaytime(noon)).toEqual(noon);
  });

  it('moves every hour of a day to daytime, never forward and by less than a day', () => {
    for (let h = 0; h < 48; h++) {
      const at = new Date(Date.UTC(2026, 10, 15, 0, 0) + h * 30 * 60_000 * 1);
      const out = demoDaytime(at);
      expect(berlinHour(out)).toBeGreaterThanOrEqual(9);
      expect(berlinHour(out)).toBeLessThanOrEqual(20);
      expect(out.getTime()).toBeLessThanOrEqual(at.getTime());
      expect(at.getTime() - out.getTime()).toBeLessThan(86_400_000);
    }
  });

  it('handles the night the clocks change', () => {
    const out = demoDaytime(new Date('2026-10-25T01:30:00Z')); // repeated hour in Berlin
    expect(berlinHour(out)).toBe(20);
  });
});
