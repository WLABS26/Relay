# Relay implementation status

Tracking document required by `docs/RELAY_BUILD_SPEC.md` §1. Update it at the end of every
milestone session. After an interruption, read this file and `git log`/`git diff` before
resuming; do not re-scaffold completed work.

- **Current branch:** `relay/m0-m1-foundation` (local; not pushed)
- **Last updated:** 2026-11-09
- **Milestones complete:** M0, M1 (acceptance gates verified locally; see evidence)
- **Next milestone:** M2 · Source to clip (see [Next runnable task](#next-runnable-task))

> Every connection in this build is **simulated**. A simulator success demonstrates workflow
> behaviour only; nothing has been published to a real platform. No real provider adapter
> exists yet, so none is "implemented" or "live-verified" in the spec's sense.

## Milestone plan

| Milestone                                | Scope (spec §13)                                                                                                                                                   | Status                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **M0 · Foundation**                      | Repo, local infra, migrations, secure auth boundary, workspaces/pages/RBAC, UI shell and design tokens                                                             | **Done**, gate verified        |
| **M1 · Original content to calendar**    | Validated uploads (video/image/carousel), drafts/revisions, destination preview, approvals, recommendation fallback, durable schedule, simulator, Results fixtures | **Done**, gate verified        |
| M2 · Source to clip                      | URL resolver, authorized attachment + rights checks, time alignment, deterministic ranker, clip editor with subtitles, rendering, export, calendar handoff         | Next                           |
| M3 · Real YouTube vertical slice         | OAuth, channel binding, resumable upload, processing/status, allowed metrics, **KMS key provider** (unblocks production start-up)                                  | Planned                        |
| M4 · Meta publishing                     | Instagram professional (image/reel/carousel), then a distinct Facebook Page adapter                                                                                | Planned; needs Meta app review |
| M5 · Sources and additional destinations | Watchlists, live monitoring, Twitch source/clips, TikTok manual export + review-gated adapter                                                                      | Planned; needs TikTok audit    |
| M6 · Results and rules                   | Age-aligned comparisons, conversions/revenue, evidence-backed slots, experiments, supervised automation                                                            | Planned                        |
| M7 · Production readiness                | Load/failure injection, dashboards, retention jobs, backup restore, compliance matrix, staged deployment runbook                                                   | Planned                        |

### M0 checklist

- [x] pnpm monorepo, pinned toolchain (Node 22.23.4, pnpm 10.28.0, TypeScript 5.9 strict)
- [x] Local infra via Compose: PostgreSQL 16.6 and an S3-compatible store (versitygw), both digest-pinned
- [x] SQL-first migrations with checksums, advisory lock, generated Kysely types with a drift check
- [x] Three database roles (`relay_migrator`, `relay_app`, `relay_worker`), none with `BYPASSRLS`
- [x] Forced row-level security with transaction-local tenant context; composite tenant foreign keys
- [x] Sessions in Postgres (hashed tokens, rotation on sign-in, idle and absolute expiry); OIDC (PKCE, state, nonce)
- [x] CSRF: strict Origin/Fetch-Metadata check plus a session-bound HMAC token; nonce CSP; security headers on pages and API
- [x] Workspaces, pages, memberships, invitations (hashed, expiring tokens), last-owner protection, page-scoped roles
- [x] Fail-closed configuration: production refuses demo mode, default secrets, http URLs, local keyrings (exit 78)
- [x] UI shell with design tokens (light/dark), accessible primitives; design-kit vectors flagged as missing (stand-ins)

### M1 checklist

- [x] Presigned single and multipart uploads; size bound in the signature; `If-None-Match: *` blocks late replacement
- [x] Workspace quota reservations; abort/expiry cleanup of partial objects
- [x] Sandboxed FFmpeg/ffprobe validation (argv only, PATH-only env, forced demuxers, protocol whitelist, resource limits, process-group kill)
- [x] Hostile media rejected and deleted: malformed, truncated, CENC-encrypted, mislabeled; ISO-BMFF protection scan fails closed when incomplete
- [x] Thumbnails and video proxies; rotation, odd dimensions and silent video normalised
- [x] Posts with immutable revisions, per-destination intents and previews, capability resolution per destination
- [x] Approvals bound to the normalised intent hash; any change invalidates exactly the affected destinations; per-destination batch outcomes
- [x] DST-correct scheduling (nonexistent and ambiguous local times are never guessed); quiet hours, spacing, daily/weekly caps, lead time
- [x] Slot reservations with a unique active slot per account; concurrent schedules serialised by row locks
- [x] Cold-start slot recommender, labelled as such, never reserving anything
- [x] Worker: fenced leases, attempt ledger written before side effects, bounded retries honouring Retry-After
- [x] Unknown outcomes go to reconciliation; never resent unless the provider proves the post was not sent; operator link/close
- [x] Pause/resume per page and workspace, global kill switch, cancel and reschedule
- [x] Deterministic simulator (reliable, slow processing, rate limit, transient error, lost response, ambiguous, format rejection)
- [x] Results from simulated metrics with explicit availability (never "0" for missing data)
- [x] Demo seed: two tenants, five Fernhill roles, a week of scheduled posts, review queue, mixed-outcome lab

## Acceptance gate evidence (2026-11-09, local)

**M0: "Fresh checkout runs using documented commands."** The commands in the README were run
from a clean clone (see [Commands verified](#commands-verified)).

**M0: "Two seeded tenants cannot see or mutate each other's records or signed media."**
`tests/integration/tenancy.test.ts` (9 tests: fail-closed without tenant context, cross-tenant
writes and composite FKs rejected, no context leakage across pooled connections, per-role least
privilege, read-only maintenance scans, `not_found` for cross-tenant IDs through every service,
signed URLs bound to their key, expiry). Over HTTP: `apps/web/e2e/security.spec.ts`
(cross-tenant 404s for pages, posts, assets and media URLs; tampered signed URL 403; bare object 403).

**M0: "Demo credentials fail closed in production config."** `apps/web/e2e/fail-closed.spec.ts`
starts the real web server and worker with production settings: demo mode and default secrets
exit 78; an otherwise valid production config also exits 78 until the KMS provider exists.
`packages/config/src/env.test.ts` covers each production rule. `tests/integration/access.test.ts`
shows demo sign-in and existing demo sessions stop working when demo mode is off.

**M1: "Playwright proves upload → approval → schedule → worker → confirmed mock post."**
`apps/web/e2e/publish-flow.spec.ts`: a marketer uploads a video in the browser, the worker
validates it, it is submitted, approved, scheduled, dispatched by the worker and confirmed by
the simulator, with a "Simulated" label throughout. The same suite also passed against the
production container images (14/14).

**M1: "Verify pause/cancel, reschedule, mixed outcomes, DST and concurrent slot collisions."**
`tests/integration/scheduling.test.ts` (pause before claim blocks, claim before pause stays in
flight, resume; move, lock, cancel; spring-forward gap and fall-back fold; concurrent exact-slot
and minimum-gap collisions; per-destination edit invalidation; idempotent replays; batch
approval). `tests/integration/reliability.test.ts` (mixed published/rejected/unknown on one
post; lost response reconciled with exactly one remote post; worker death before/after the
provider write; repeated 429s give up without dispatching; rights revoked after preparation).

### Test totals

| Suite                                       | Command                                                        | Result                |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------- |
| Unit                                        | `pnpm test`                                                    | 203 passed (17 files) |
| Integration (real Postgres, S3, FFmpeg)     | `pnpm test:integration`                                        | 51 passed (6 files)   |
| End-to-end (Playwright, production build)   | `pnpm test:e2e`                                                | 14 passed             |
| E2E against container images                | `E2E_BASE_URL=… pnpm --filter @relay/web exec playwright test` | 14 passed             |
| Uploads with FFmpeg inside the worker image | uploads suite with image-backed `FFPROBE_PATH`/`FFMPEG_PATH`   | 16 passed             |
| Lint (ESLint, zero warnings) + source check | `pnpm lint`                                                    | clean                 |
| Types                                       | `pnpm typecheck`                                               | clean (10 packages)   |
| Format                                      | `pnpm format:check`                                            | clean                 |

## Architecture decisions

Full records in [`docs/architecture/decisions.md`](architecture/decisions.md). Material
deviations from the spec's greenfield defaults:

1. **Kysely + SQL-first migrations** instead of an ORM schema DSL: RLS policies, triggers and
   grants are first-class SQL; types are generated from the live schema and drift-checked.
2. **versitygw** for local S3: the MinIO images were unavailable in this environment;
   versitygw passed an empirical S3-feature probe (presign, multipart, versioning, conditional writes, CORS).
3. **KMS deferred to M3, production fails closed** rather than storing secrets under a local key.
4. **`style-src 'unsafe-inline'`** for React style attributes; scripts remain nonce-bound (`'strict-dynamic'`).
5. **SECURITY DEFINER `relay_enqueue_job`** so the app role can enqueue transactionally without table access to Graphile's schema.
6. **Worker image on Ubuntu 24.04** for FFmpeg 6.1 (the version the hostile-media suite is verified against).

## Provider capabilities

Summary; details and documentation links in [`docs/providers/matrix.md`](providers/matrix.md).

| Provider                 | Simulated (demo)               | Real adapter          | Contract-tested | Live-verified |
| ------------------------ | ------------------------------ | --------------------- | --------------- | ------------- |
| YouTube                  | Yes                            | No (M3)               | No              | No            |
| Instagram (professional) | Yes                            | No (M4)               | No              | No            |
| Facebook Page            | Yes                            | No (M4)               | No              | No            |
| TikTok                   | Yes                            | No (M5, review-gated) | No              | No            |
| Twitch                   | Not a destination (source, M5) | No                    | No              | No            |

## Unresolved external approvals and operator actions

None of these can be completed from code; each needs a separate operator action.

- **Google/YouTube:** OAuth client, consent screen verification, API quota, and the audit for
  unverified-app upload restrictions (M3).
- **Meta:** app review for Instagram content publishing and Pages permissions; business verification (M4).
- **TikTok:** Content Posting API audit and approved use case before any direct post (M5).
- **Twitch:** application registration and EventSub webhook secret (M5).
- **Production:** KMS key and IAM policy, OIDC provider registration with exact redirect
  `https://<host>/api/auth/oidc/callback`, managed Postgres with the three roles, private bucket and CORS.
- **Design:** the Relay Design System kit (`Relay_Design_System.zip`) was not provided; vector
  marks are stand-ins (see `design/relay/README.md`).

## Known constraints and gaps

- Production start-up is intentionally blocked until the KMS key provider lands (M3).
- No real provider adapters; switching from demo to a test account requires M3 (see the operations runbook).
- Invitation e-mail delivery is not implemented: the invite link is shown to the inviter to share.
- Expired sessions and login attempts are not yet purged by a retention job (planned with M7 retention).
- Provider documentation was **not re-verified** in this session; no endpoint versions or scopes were chosen yet.
- The web server exits immediately on SIGTERM without draining. All mutations are transactional
  and idempotent, so an interrupted request rolls back and can be retried safely.
- The worker image is about 1 GB, mostly Ubuntu's FFmpeg codec libraries.

## Commands verified

Run on 2026-11-09 from a **clean clone of commit `dfadfd3`** (Linux container, Docker 29.9,
Node 22.23.4, pnpm 10.28.0). The clone used its own Compose project
(`COMPOSE_PROJECT_NAME=relayfresh`, alternate host ports in `.env`) so every run started
from empty volumes without touching other local data; otherwise the commands are exactly
as documented.

| Command                          | Result                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | ok (lockfile-exact)                                                                                      |
| `cp .env.example .env`           | ok                                                                                                       |
| `pnpm infra:up`                  | Postgres and S3 healthy; bucket provisioned                                                              |
| `pnpm db:migrate`                | 11 applied from empty; Graphile Worker schema revision 20                                                |
| `pnpm db:types:check`            | generated types are up to date                                                                           |
| `pnpm fixtures:generate`         | 12 synthetic files (valid and hostile) in 11 s                                                           |
| `pnpm db:seed`                   | Fernhill (3 pages, 12 posts) and Kestrel (1 page) in 13.6 s                                              |
| `pnpm dev` + `pnpm worker:dev`   | both ready; demo sign-in 200; Fernhill pages 200; Kestrel 404 for a Fernhill-only user; no errors logged |
| `pnpm typecheck`                 | clean (10 packages)                                                                                      |
| `pnpm lint`                      | clean, zero warnings; source check passed                                                                |
| `pnpm format:check`              | clean                                                                                                    |
| `pnpm test`                      | 203 passed                                                                                               |
| `pnpm test:integration`          | 51 passed                                                                                                |
| `pnpm test:e2e`                  | production build, then 14 passed                                                                         |

Container images (built from the working tree at the same commit):

| Command                                                    | Result                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `docker build -f infra/docker/worker.Dockerfile .`         | built (Ubuntu 24.04, FFmpeg 6.1.1, Node 22.23.4, uid 10001)            |
| `docker build -f infra/docker/web.Dockerfile .`            | built (Next.js standalone, uid 1000); builds with an empty environment |
| `docker run … relay-worker node dist/migrate.js`           | 11 migrations applied to an empty database                             |
| E2E against both images (read-only root, no capabilities)  | 14 passed                                                              |
| Upload suite with FFmpeg executing inside the worker image | 16 passed (negative control fails as expected)                         |

## Next runnable task

Start **M2 · Source to clip** with the rights model, which M2's gate depends on: add
owner/admin commands to grant and revoke rights per asset (the dispatch-time recheck and the
`rights_changed` block already exist and are tested), then the URL resolver with SSRF
protection (spec §6) feeding authorized file attachment.
