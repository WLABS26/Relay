# Relay

A publishing workspace for social media marketers and clippers: upload finished media, review
exactly what each destination will receive, schedule it in each page's time zone, and let a
durable worker publish it, with every outcome (including the uncertain ones) visible.

> **Status: milestones M0 and M1 are complete.** Every connection is **simulated** by a
> deterministic provider simulator. Simulated posts demonstrate workflow behaviour only;
> nothing is ever sent to a real platform. See
> [`docs/implementation-status.md`](docs/implementation-status.md).

## Quick start

Prerequisites: Node 22.18+ (`.nvmrc` pins 22.23.4), pnpm 10.28 (`corepack enable`), Docker
with Compose v2, and FFmpeg 6.x on `PATH` (the worker, fixture generator and integration tests
run it). On Linux, `prlimit` (util-linux) adds resource caps to FFmpeg; without it Relay runs
FFmpeg with timeouts only.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm infra:up
```

```bash
pnpm db:migrate
```

```bash
pnpm fixtures:generate
```

```bash
pnpm db:seed
```

Then run the web app and the worker in two terminals:

```bash
pnpm dev
```

```bash
pnpm worker:dev
```

Open <http://localhost:3000> and pick a demo account. `pnpm infra:up` is
`docker compose -f infra/compose.yaml up -d --wait` plus waiting for bucket provisioning.

### Demo accounts (demo mode only)

| Workspace                       | Person         | Role                                  |
| ------------------------------- | -------------- | ------------------------------------- |
| Fernhill Studio (`/w/fernhill`) | Mara Lindqvist | Owner                                 |
|                                 | Theo Brandt    | Admin                                 |
|                                 | Priya Raman    | Publisher (Fernhill Coffee page only) |
|                                 | Eli Novak      | Editor                                |
|                                 | Vic Osei       | Viewer                                |
| Kestrel Media (`/w/kestrel`)    | Gus Ferreira   | Owner                                 |
|                                 | Kim Sato       | Editor                                |

The seed includes published history with simulated results, a week of scheduled posts, a
review queue, a draft, and a **Simulator lab** page with mixed outcomes (rejected, unknown,
rate limited, slow processing). All seeded data is synthetic and labelled.

## Commands

| Command                                                       | Purpose                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm infra:up` / `infra:down` / `infra:reset` / `infra:logs` | Local Postgres 16 and S3-compatible storage (reset deletes volumes)                  |
| `pnpm db:migrate`                                             | Apply SQL migrations (checksummed, advisory-locked) and the Graphile Worker schema   |
| `pnpm db:seed`                                                | Demo tenants and content, created through the real services                          |
| `pnpm db:reset`                                               | Recreate the local database from migrations (local/test only)                        |
| `pnpm db:types` / `db:types:check`                            | Regenerate Kysely types / fail on schema drift                                       |
| `pnpm fixtures:generate`                                      | Deterministic synthetic media, valid and hostile                                     |
| `pnpm storage:provision`                                      | Create the bucket with versioning and CORS                                           |
| `pnpm dev` / `pnpm worker:dev`                                | Web app on :3000 / worker (both pools, health on :3101)                              |
| `pnpm build` / `start` / `worker:start`                       | Production builds and servers                                                        |
| `pnpm test`                                                   | Unit tests (no I/O)                                                                  |
| `pnpm test:integration`                                       | Real Postgres, S3 and FFmpeg; uses the `relay_test` database and `relay-test` bucket |
| `pnpm test:e2e`                                               | Production build plus Playwright against an isolated stack (`relay_e2e`, port 3100)  |
| `pnpm lint` / `typecheck` / `format:check`                    | ESLint (zero warnings) plus source check / types / Prettier                          |
| `pnpm check`                                                  | Typecheck, lint and unit tests                                                       |

Playwright needs Chromium: `pnpm --filter @relay/web exec playwright install chromium`.
To run the E2E suite against an already-running, demo-seeded stack (such as the container
images), set `E2E_BASE_URL`.

## Architecture

```
apps/web        Next.js App Router: pages, /api/v1 route handlers (thin), CSP proxy
apps/worker     Graphile Worker: general pool (publish, reconcile, metrics, cron), media pool (FFmpeg)
packages/
  config        Validated, fail-closed environment schema
  domain        Pure logic: states, scheduling and DST, recommender, capabilities, media rules
  db            SQL migrations, roles and RLS, Kysely client, tenant/bootstrap contexts
  media         S3 storage, sandboxed FFmpeg/ffprobe, ISO-BMFF protection scan, fixtures
  providers     Adapter contracts, provider catalogue, deterministic simulator
  services      Every command and query (RBAC, tenancy, transactions, audit, idempotency)
  ui            Design tokens, accessible primitives, stand-in marks
infra/          Compose for local infra, Dockerfiles, production compose template
tests/          Integration suites against real Postgres, S3 and FFmpeg
```

A request or a task always goes through `services`, which opens a tenant transaction
(`relay.workspace_id` etc. are transaction-local), checks the role matrix and page scope,
writes the change, an audit event and any job in one transaction, and returns.

## Documentation

- [Implementation status](docs/implementation-status.md): milestones, evidence, constraints, next task
- [Architecture decisions](docs/architecture/decisions.md)
- [Security model](docs/security-model.md)
- [Provider matrix](docs/providers/matrix.md)
- [Worker task catalog](docs/worker-tasks.md)
- [Operations runbook](docs/runbooks/operations.md): health, jobs, recovery, media cleanup, demo → test account
- [Onboarding](docs/onboarding.md): conventions and how to extend Relay
- [Build specification](docs/RELAY_BUILD_SPEC.md)

## Deployment

`infra/docker/web.Dockerfile` and `infra/docker/worker.Dockerfile` build the images;
`infra/compose.prod.example.yaml` is a hardened template (read-only root, no capabilities, one
worker per pool, migrations as an explicit operator step). **Production intentionally refuses
to start until the KMS key provider ships in M3**; staging (`RELAY_ENV=staging`) runs today.
Deploys, migrations and provider console changes are always separate operator actions.
