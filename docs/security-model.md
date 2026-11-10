# Relay security model

What Relay defends, how, and where each control is tested. Spec references: §4 (access),
§6 (media), §7 (OAuth), §12 (security and operations).

## Tenancy

| Control                          | Implementation                                                                                                                                                                                                                                                                                    | Evidence                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tenant isolation in the database | `FORCE ROW LEVEL SECURITY` on tenant tables; policies read transaction-local `relay.*` settings                                                                                                                                                                                                   | `tenancy.test.ts` "returns zero tenant rows without a tenant context"       |
| No cross-tenant references       | Composite `(workspace_id, id)` foreign keys                                                                                                                                                                                                                                                       | `tenancy.test.ts` "composite foreign keys…"                                 |
| No context leakage               | `set_config(…, true)` (transaction-local) on pooled connections                                                                                                                                                                                                                                   | `tenancy.test.ts` "never leaks tenant context across pooled connections"    |
| Least privilege                  | `relay_app` and `relay_worker` have column-level grants, no `BYPASSRLS`, no DDL                                                                                                                                                                                                                   | `tenancy.test.ts` "enforces least privilege per database role"              |
| Worker scans                     | A read-only maintenance scope returns IDs only; every action re-reads in a tenant transaction                                                                                                                                                                                                     | `tenancy.test.ts` "allows worker maintenance scans to read but never write" |
| No existence leaks               | Cross-tenant IDs return `not_found` (never `forbidden`) through services and HTTP                                                                                                                                                                                                                 | `tenancy.test.ts`, `e2e/security.spec.ts`                                   |
| Immutable history                | Triggers make post and policy revisions, publish intents and audit events append-only                                                                                                                                                                                                             | migrations 0003, 0006, 0008                                                 |
| Single-login staging databases   | One owner login; each pooled connection has the server assume `relay_app`/`relay_worker` at session start and is rejected unless `current_user` confirms it; the login gets SET without INHERIT; pre-existing roles with elevated attributes are refused; direct host only; refused in production | `single-login.test.ts`, `env.test.ts` "database logins"                     |

## Authentication and sessions

- **OIDC** (openid-client): authorization code with PKCE, `state` and `nonce`; the verifier is
  envelope-encrypted at rest for the duration of the attempt. Optional e-mail domain allowlist.
- **Demo sign-in** exists only when `RELAY_DEMO_MODE=true` and never in production; existing
  demo sessions stop working as soon as demo mode is off.
- **Sessions** live in Postgres. The cookie carries a 256-bit random token; only its SHA-256 is
  stored. Sliding idle timeout plus absolute lifetime; rotation on sign-in (fixation defence);
  server-side revocation on sign-out. Cookies are `HttpOnly`, `SameSite=Lax`, and use the
  `__Host-` prefix with `Secure` whenever the public URL is HTTPS.

## Request integrity

- **CSRF, layer 1:** every mutation must carry `Origin` equal to the public origin, or, when
  `Origin` is absent, `Sec-Fetch-Site: same-origin`. `Origin: null` and header-less clients are
  refused (`apps/web/src/lib/server/origin.ts`, unit-tested).
- **CSRF, layer 2:** an HMAC token bound to the session ID (double-submit via a non-HttpOnly,
  `SameSite=Strict` cookie and the `X-CSRF-Token` header), compared in constant time.
- **Idempotency keys** (creating posts, starting uploads, scheduling) are recorded inside the
  business transaction: a replay returns the original response; reusing a key with a different
  body is refused. Other state changes require `expectedVersion` (optimistic concurrency).
- **Error envelope** `{code, message, fieldErrors?, retryAfterSeconds?, details?, requestId}`;
  internal errors never include stack traces, SQL or provider payloads.

## Browser hardening

- Pages: per-request nonce CSP with `'strict-dynamic'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`; `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy`, COOP `same-origin`, and HSTS on HTTPS.
- API responses (errors included): `nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.

## Uploads and media

- Object keys are generated by the server (`ws/<workspace>/assets/<asset>/v<n>/…`); clients
  never choose keys. The bucket is private; media is served only through short-lived signed
  URLs minted after an authorization check, bound to their key, and expiring (tested).
- Presigned PUTs bind content type and length; `If-None-Match: *` prevents a late PUT from
  replacing validated bytes. Multipart parts are server-numbered; ETags are not treated as hashes.
- The worker downloads the exact object version (`If-Match`), enforces the declared size while
  streaming, computes SHA-256 itself, and checks magic bytes against the declared type.
- **FFmpeg sandbox:** argv only (no shell), PATH-only environment, forced demuxers, protocol
  whitelist (`file` only), `prlimit` caps (address space, CPU, output size), timeouts that
  kill the whole process group, at most 8 streams. Bundled in the worker image with FFmpeg 6.1.
- **Encrypted media** is rejected: ffprobe stream and packet side-data checks, plus an ISO-BMFF
  box scan for protected sample entries and DRM boxes. The scan has one global budget (boxes,
  depth, container size) and fails closed when it cannot inspect the whole tree.
- Rejected uploads have every stored version deleted. Display filenames are stripped of
  control, bidirectional-override and zero-width characters.
- Workspace storage quotas are reserved before any upload URL is issued.

## Secrets

- `.env.example` holds placeholders only; real values come from the operator's secrets manager.
- Provider credentials and OIDC verifiers use envelope encryption (AES-256-GCM, a fresh data
  key per value, associated data bound to tenant, provider, grant and purpose). A ciphertext
  moved to another row or tenant fails to decrypt (unit-tested). Key rotation keeps old keys
  for decryption only.
- Production requires KMS and refuses to start until the KMS provider ships (M3).

## Fail-closed configuration

`packages/config` validates the environment once. In production it refuses demo mode, known
development secrets, http public/OIDC/storage URLs, local keyrings and missing OIDC. Web and
worker exit with code 78 before serving anything (E2E-tested). `RELAY_ENV` defaults to
production whenever `NODE_ENV=production`, so a forgotten variable cannot enable demo mode.

Hosted staging may run from a single database login (`DATABASE_URL` alone) with the worker
creating roles, applying migrations and preparing the bucket on start-up (`RELAY_AUTO_MIGRATE`,
`RELAY_AUTO_SEED`). All three are refused in production, and a `DATABASE_URL` that points at a
connection pooler is refused in any environment because transaction pooling would drop the role
switch (`env.test.ts` "database logins", `bootstrap.test.ts`).

On a serverless platform the web app cannot refuse to start, so its request proxy answers every
page with a 503 "Relay is not configured yet" page while the configuration is invalid. Outside
production the page lists the problems (variable names and rules, never values); in production
it only points at the server log (`config-gate.test.ts`).

## Provider safety

- Simulated connections only work in demo mode, are labelled everywhere, and use a reserved
  `.invalid` permalink host. Live mode never falls back to the simulator.
- Capability checks (implementation, deployment flag, platform approval, scopes, account
  type, format, visibility, policy, health) run before scheduling and again before every dispatch.
- A global kill switch (`RELAY_PUBLISH_KILL_SWITCH`) and page/workspace pauses stop new dispatches.

## Source hygiene

`pnpm lint` fails on Unicode bidirectional controls, zero-width characters and stray control
bytes anywhere in the source tree (`scripts/check-source.mjs`, Trojan Source / CVE-2021-42574).

## Known gaps (tracked in the implementation status)

KMS provider (M3); OAuth token storage for providers (M3); webhook signature verification
(M3–M5); SSRF-safe URL resolver (M2); session and login-attempt retention jobs (M7).
