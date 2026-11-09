import { describe, expect, it } from 'vitest';
import {
  ManualClock,
  createIdGenerator,
  hashToSeed,
  isUuid,
  seededRandom,
  seededRandomBytes,
  uuidv7,
} from './ids';

describe('uuidv7', () => {
  it('encodes the millisecond timestamp, version 7 and the RFC variant', () => {
    const id = uuidv7(Date.parse('2026-11-09T10:00:00.123Z'), seededRandomBytes(1));
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(new Date(ms).toISOString()).toBe('2026-11-09T10:00:00.123Z');
  });

  it('sorts by creation time across milliseconds', () => {
    const ids = [3, 1, 2].map((n) => uuidv7(1_700_000_000_000 + n));
    expect([...ids].sort()).toEqual([1, 2, 3].map((n) => ids[[3, 1, 2].indexOf(n)]));
  });

  it('follows an injected clock', () => {
    const clock = new ManualClock('2026-01-01T00:00:00Z');
    const gen = createIdGenerator(clock);
    const a = gen.next();
    clock.advance(1);
    expect(gen.next() > a).toBe(true);
  });
});

describe('deterministic helpers', () => {
  it('seeded randomness repeats exactly for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(xs[0]);
  });

  it('hashes strings to stable 32-bit seeds', () => {
    expect(hashToSeed('relay')).toBe(hashToSeed('relay'));
    expect(hashToSeed('relay')).not.toBe(hashToSeed('Relay'));
    expect(hashToSeed('')).toBe(0x811c9dc5);
  });

  it('manual clocks only move when told to', () => {
    const c = new ManualClock('2026-11-09T10:00:00Z');
    expect(c.now().toISOString()).toBe('2026-11-09T10:00:00.000Z');
    c.advance(60_000);
    expect(c.now().toISOString()).toBe('2026-11-09T10:01:00.000Z');
    c.set('2027-01-01T00:00:00Z');
    expect(c.now().getUTCFullYear()).toBe(2027);
  });
});
