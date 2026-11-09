/**
 * CSRF origin rule for state-changing API requests (first of two layers; the second is the
 * session-bound double-submit token). Browsers send `Origin` on every cross-origin request
 * and on same-origin non-GET fetches. When it is absent, Fetch Metadata must say the request
 * is same-origin. Everything else is refused, including `Origin: null` (sandboxed frames,
 * some redirects) and non-browser clients that send neither header.
 */
export function originAllowed(
  headers: { origin: string | null; secFetchSite: string | null },
  publicOrigin: string,
): boolean {
  if (headers.origin !== null) return headers.origin === publicOrigin;
  return headers.secFetchSite === 'same-origin';
}
