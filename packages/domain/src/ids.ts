/**
 * Identifier and clock primitives. Inject these (never call Date.now()/random directly in
 * domain code) so scheduling, ranking and tests stay deterministic.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(to: Date | string): void {
    this.current = new Date(to).getTime();
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/** Deterministic PRNG (mulberry32) for seeded tests, fixtures and simulator behaviour. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandomBytes(seed: number): RandomBytes {
  const next = seededRandom(seed);
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(next() * 256);
    return bytes;
  };
}

/** Stable 32-bit FNV-1a hash of a string, used to derive deterministic seeds. */
export function hashToSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * RFC 9562 UUID version 7: 48-bit Unix millisecond timestamp, then random bits.
 * Time-ordered IDs keep B-tree inserts local and make (created_at, id) cursors stable.
 */
export function uuidv7(nowMs: number = Date.now(), random: RandomBytes = cryptoRandomBytes): string {
  const bytes = random(16);
  const ts = BigInt(Math.max(0, Math.floor(nowMs)));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i]!];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

export interface IdGenerator {
  next(): string;
}

export function createIdGenerator(clock: Clock = systemClock, random?: RandomBytes): IdGenerator {
  return { next: () => uuidv7(clock.now().getTime(), random) };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
