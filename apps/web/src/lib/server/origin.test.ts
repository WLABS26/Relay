import { describe, expect, it } from 'vitest';
import { originAllowed } from './origin';

const PUBLIC = 'https://relay.example';

describe('originAllowed (CSRF origin rule for mutations)', () => {
  it.each<[string, string | null, string | null, boolean]>([
    ['same origin', PUBLIC, 'same-origin', true],
    ['same origin without fetch metadata', PUBLIC, null, true],
    ['another site', 'https://evil.example', 'cross-site', false],
    ['a subdomain', 'https://app.relay.example', 'same-site', false],
    ['the http variant', 'http://relay.example', null, false],
    ['another port', 'https://relay.example:8443', null, false],
    ['Origin: null (sandboxed frame)', 'null', 'cross-site', false],
    ['no Origin, fetch metadata same-origin', null, 'same-origin', true],
    ['no Origin, same-site', null, 'same-site', false],
    ['no Origin, user-initiated navigation', null, 'none', false],
    ['a non-browser client with neither header', null, null, false],
  ])('%s → %s', (_, origin, secFetchSite, expected) => {
    expect(originAllowed({ origin, secFetchSite }, PUBLIC)).toBe(expected);
  });
});
