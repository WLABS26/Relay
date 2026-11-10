# Architecture decisions

Short records for material choices and deviations from the spec's greenfield defaults
(spec §1). Each states the context, the decision and its consequences. Newest last.

## ADR-001 · Monorepo with a services layer between apps and the database

**Context.** Web requests and worker tasks must enforce identical rules (RBAC, tenancy,
state transitions, capability checks) and share one transaction model.

**Decision.** pnpm workspace: `apps/web` (Next.js), `apps/worker` (Graphile Worker), and
packages `config`, `domain` (pure logic, no I/O), `db`, `media`, `providers`, `services`
(all commands and queries), `ui`. Route handlers and tasks are thin adapters over `services`.

**Consequences.** Authorization lives in one place and is exercised by integration tests that
call services directly. Workspace packages ship TypeScript source; the web app transpiles
them and the worker bundles them with esbuild.

## ADR-002 · Kysely with SQL-first migrations instead of an ORM schema DSL

**Context.** Security depends on PostgreSQL features an ORM DSL models poorly: forced RLS
policies, column-level grants, immutability triggers, SECURITY DEFINER functions.

**Decision.** Plain SQL migrations (`packages/db/migrations/NNNN_*.sql`), applied under an
advisory lock with SHA-256 checksums (editing an applied file is refused). Kysely provides
typed queries; `kysely-codegen` generates `src/generated/db.ts` from a migrated database, and
`pnpm db:types:check` fails if the committed types drift from the schema.

**Consequences.** Reviewers read the real security model in SQL. Adding a column means a
migration plus `pnpm db:types`.

## ADR-003 · Three database roles and forced RLS

**Decision.** `relay_migrator` owns objects; `relay_app` (web) and `relay_worker` (worker) get
least-privilege grants, never `BYPASSRLS`. Tenant tables use `FORCE ROW LEVEL SECURITY` with
policies on transaction-local settings (`relay.workspace_id`, `relay.user_id`,
`relay.auth_context`, `relay.scope`) set via `set_config(..., true)`. Composite
`(workspace_id, id)` foreign keys make cross-tenant references impossible. Pre-tenant lookups
(sign-in, invitations, membership resolution) go through narrowly scoped bootstrap contexts.

**Consequences.** Missing tenant context returns zero rows (fail closed). Pooled connections
cannot leak context because it is transaction-local. Verified in `tenancy.test.ts`.

## ADR-004 · Transactional enqueue through `relay_enqueue_job` (SECURITY DEFINER)

**Context.** Jobs must be enqueued in the same transaction as the business change (outbox
semantics), but the app role must not get table access to Graphile Worker's private schema.

**Decision.** Migration 0010 adds `relay_enqueue_job`, a SECURITY DEFINER function with a pinned
`search_path` that calls `graphile_worker.add_job`. The post-migration script revokes app
access to the queue tables and grants the worker role what Graphile needs. The Graphile
schema revision is pinned (20) and checked at start-up.

## ADR-005 · Approvals bind to a normalised intent hash

**Decision.** Each destination's publish intent (media versions and hashes, caption, title,
visibility, metadata, declarations, target account, rights grants) is canonicalised
(`canonicalJson`) and hashed. Approvals store that hash; scheduling and the worker recompute it.
Any change invalidates the approval for exactly the destinations it affects.

**Consequences.** A reviewer approves precisely what will be published. A stale batch decision
is refused per destination while the other decisions apply.

## ADR-006 · Publishing: immutable intents, fenced leases, ledger before side effects

**Decision.** Scheduling creates an immutable intent with operation key
`workspace:destination:revision:intentVersion` and reserves a slot (unique active exact slot per
account; lock order account → page → workspace → post destination). The worker claims a fenced
lease (`lease_token`), writes an attempt row before calling the provider, and records the
outcome. Unknown outcomes move to `needs_reconciliation`; Relay never resends unless the
provider proves the post was not sent. Operators can link an external post or close as not published.

**Consequences.** A crashed or partitioned worker cannot double-publish (covered by takeover
tests before and after the provider write).

## ADR-007 · DST-correct civil time with Temporal

**Decision.** `temporal-polyfill` for zone arithmetic. Nonexistent local times (spring
forward) are refused with the next valid time suggested; ambiguous times (fall back) require an
explicit offset unless the page rule chooses earlier/later. Instants are stored in UTC with the
civil time, zone and offset recorded on the intent.

## ADR-008 · versitygw instead of MinIO for local S3

**Context.** The MinIO images could not be pulled in the build environment.

**Decision.** Use `versity/versitygw` (digest-pinned) after an empirical probe of the features
Relay needs: presigned PUT/GET, multipart, versioning, conditional writes (`If-None-Match`), CORS.
The application uses only the standard S3 API, so any compliant store (AWS S3, MinIO, R2)
works by configuration.

## ADR-009 · PostgreSQL 16.6

PostgreSQL 16 supports every feature used (forced RLS, `DROP DATABASE … WITH (FORCE)`,
SECURITY DEFINER with pinned search paths, role grants with the `SET` option). The image is
digest-pinned in Compose. 16 is the minimum, not a ceiling: hosted staging on Neon gets
PostgreSQL 18 by default, so CI runs the integration suite on 16 and 18.

## ADR-010 · TypeScript 5.9

Pinned to the current stable 5.9 line (strict mode, `noImplicitReturns`,
`noUncheckedIndexedAccess`). Upgrade deliberately with the lockfile.

## ADR-011 · KMS deferred to M3; production fails closed

**Context.** Provider OAuth tokens (M3+) must be envelope-encrypted under a KMS key in
production. The KMS key provider is part of the provider-credential milestone.

**Decision.** Production configuration requires `RELAY_ENCRYPTION_PROVIDER=kms`, and this build
refuses to start with it (exit 78) rather than silently using a local keyring. The envelope
format (AES-256-GCM, per-value data key, AAD bound to tenant, provider, grant and purpose) and
local keyring rotation are implemented and tested now.

**Consequences.** No production deployment is possible before M3. Staging (`RELAY_ENV=staging`)
can run with a local keyring.

## ADR-012 · CSP allows inline styles, never inline scripts

React `style` attributes need `style-src 'unsafe-inline'`. Scripts use a per-request nonce with
`'strict-dynamic'`; `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`.
Style injection cannot execute script under this policy.

## ADR-013 · Deterministic provider simulator as a separate "remote" system

**Decision.** The simulator keeps its state in its own `provider_sim` schema, keyed by the
operation key, and is called outside business transactions like a real API. Profiles script
behaviour (slow processing, rate limits, transient errors, lost responses, ambiguous outcomes,
format rejection). Simulated accounts, posts and metrics are labelled everywhere, use a
reserved `.invalid` permalink host, and are refused outside demo mode.

## ADR-014 · Worker runtime on Ubuntu 24.04

**Context.** Media validation is a security boundary, verified against hostile fixtures with
FFmpeg 6.1. Debian bookworm (the default Node image base) ships FFmpeg 5.1.

**Decision.** The worker image copies the pinned Node binary onto Ubuntu 24.04 LTS, whose FFmpeg
is 6.1.1, the exact version the suite runs against. The upload suite was re-run with FFmpeg
executing inside the image (16/16). The web image stays on the slim Node image.

**Consequences.** A larger worker image (about 1 GB, mostly codec libraries), in exchange for
toolchain parity and LTS security updates until 2029.
