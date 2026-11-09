import { describe, expect, it } from 'vitest';
import { fingerprint, intentHash, safeEqual } from '../server';
import {
  DEFAULT_DECLARATIONS,
  canonicalJson,
  normalizeText,
  publishOperationKey,
  type PublishIntentPayload,
} from './intent';

const payload: PublishIntentPayload = {
  workspaceId: 'w1',
  postId: 'p1',
  destination: {
    pageDestinationId: 'd1',
    socialAccountId: 'a1',
    provider: 'youtube',
    connectionMode: 'simulated',
    providerAccountId: 'sim-1',
  },
  media: [{ position: 0, assetId: 'm1', assetVersion: 1, kind: 'video', sha256: 'ab'.repeat(32) }],
  caption: 'Hello',
  title: 'Title',
  visibility: 'public',
  metadata: { madeWith: 'relay', tags: null },
  declarations: DEFAULT_DECLARATIONS,
  rights: [{ assetId: 'm1', grantId: 'g1', grantVersion: 1 }],
};

describe('canonicalJson', () => {
  it('sorts keys at every depth, drops undefined properties and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
    );
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('encodes dates as ISO strings and non-finite numbers as null', () => {
    expect(canonicalJson({ at: new Date('2026-11-09T10:00:00Z') })).toBe(
      '{"at":"2026-11-09T10:00:00.000Z"}',
    );
    expect(canonicalJson([Number.NaN, Number.POSITIVE_INFINITY, -0])).toBe('[null,null,0]');
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('refuses values JSON cannot represent instead of dropping them', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson([Symbol('s')])).toThrow(TypeError);
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

/** Same value with every object's keys in reverse insertion order, at every depth. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

describe('intent hashing', () => {
  it('is stable across key order', () => {
    const reordered = reverseKeys(payload) as PublishIntentPayload;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(payload)); // really reordered
    expect(intentHash(reordered)).toBe(intentHash(payload));
    expect(intentHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, (p: PublishIntentPayload) => PublishIntentPayload]>([
    ['caption', (p) => ({ ...p, caption: 'Hello!' })],
    ['title', (p) => ({ ...p, title: null })],
    ['visibility', (p) => ({ ...p, visibility: 'private' })],
    ['media bytes', (p) => ({ ...p, media: [{ ...p.media[0]!, sha256: 'cd'.repeat(32) }] })],
    ['media version', (p) => ({ ...p, media: [{ ...p.media[0]!, assetVersion: 2 }] })],
    [
      'target account',
      (p) => ({ ...p, destination: { ...p.destination, providerAccountId: 'sim-2' } }),
    ],
    ['declarations', (p) => ({ ...p, declarations: { ...p.declarations, paidPartnership: true } })],
    ['rights grant', (p) => ({ ...p, rights: [{ ...p.rights[0]!, grantVersion: 2 }] })],
    ['metadata', (p) => ({ ...p, metadata: { ...p.metadata, tags: 'x' } })],
  ])('changes when the %s changes, so the approval no longer applies', (_, mutate) => {
    expect(intentHash(mutate(payload))).not.toBe(intentHash(payload));
  });

  it('fingerprints arbitrary request bodies the same way', () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: '1' }));
  });
});

describe('text and keys', () => {
  it('normalises Unicode to NFC and line endings to LF, nothing else', () => {
    expect(normalizeText('Café\r\nline\rend  ')).toBe('Café\nline\nend  ');
  });

  it('builds the operation key from workspace, destination, revision and intent version', () => {
    expect(
      publishOperationKey({
        workspaceId: 'w',
        postDestinationId: 'd',
        revisionId: 'r',
        intentVersion: 3,
      }),
    ).toBe('w:d:r:3');
  });

  it('compares secrets in constant time, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(Buffer.from([1, 2]), Buffer.from([1, 2]))).toBe(true);
  });
});
