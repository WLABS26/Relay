# Onboarding

How Relay is put together and how to extend it safely. Start with the README quick start,
then read [`implementation-status.md`](implementation-status.md).

## Mental model

1. **`packages/domain`** is pure: state machine (`publishing/states.ts`), civil time and DST
   (`time.ts`), slot constraints and the cold-start recommender (`scheduling/`), capability
   resolution, media rules, role matrix, error codes. No I/O; inject `Clock` and IDs.
2. **`packages/services`** owns every command and query. Each opens a tenant transaction,
   authorizes (`can(role, action)` plus page scope), validates with Zod, changes state through
   `nextState()`, writes an audit event, enqueues jobs on the same transaction, and returns.
3. **`apps/web`** route handlers wrap services with `api()` (`src/lib/server/api.ts`): request
   ID, session, CSRF (origin plus token), JSON size cap, error envelope. Pages are server
   components that call services directly.
4. **`apps/worker`** maps task identifiers to service functions. Payloads are hints; handlers re-read state.

## Conventions

- Errors are `AppError(code, message, options)` with codes from `domain/src/errors.ts`; codes
  are stable API surface. Cross-tenant access is always `not_found`.
- Commands that create things (`createPost`, `startUpload`, `scheduleDestination`) honour an
  `Idempotency-Key` via `withIdempotency`; state changes on existing resources require
  `expectedVersion`, so a retried request either applies once or fails with `version_conflict`.
- Times: store UTC instants; accept civil time plus zone; never guess a DST fold or gap.
- Labels: anything simulated shows the "Simulated" badge; suggested slots are never shown as scheduled.
- Accessibility: keyboard-reachable controls, visible focus, labelled inputs, `aria-live` for
  async results, reduced motion respected, both themes checked.

## Adding a migration

1. Create `packages/db/migrations/NNNN_description.sql` with the next number. Enable and force
   RLS on new tenant tables, add composite `(workspace_id, id)` keys and FKs, and grant
   least-privilege access to `relay_app`/`relay_worker` (column-level where possible).
2. `pnpm db:migrate`, then `pnpm db:types` and commit `src/generated/db.ts`.
3. Bump `REQUIRED_SCHEMA_VERSION` in `packages/db/src/schema-version.ts` (a unit test checks it).
4. Add an isolation test in `tests/integration/tenancy.test.ts` for any new tenant table.

## Adding a command or endpoint

Write the service function first (with its RBAC action and transitions), cover it with an
integration test, then add a thin route under `apps/web/src/app/api/v1/…` using `api()`.

## Adding a worker task

Add it to `TASKS` in `packages/services/src/tasks.ts` (pool, Zod payload, attempts), handle it
in `apps/worker/src/main.ts`, enqueue it with a job key on the business transaction, and
document it in [`worker-tasks.md`](worker-tasks.md).

## Adding a provider adapter (M3+)

Implement `PublishingAdapter` (and optionally `MetricsAdapter`) from
`packages/providers/src/types.ts`:

- `advance()` performs one phase and returns one of `continue`, `waiting`, `confirmed`,
  `rejected`, `rate_limited`, `retryable` or `unknown`. Return `unknown` whenever a side effect
  may have happened without proof; never `retryable`.
- `reconcile()` must prove outcomes by idempotent lookup (operation key) or return `indeterminate`.
- `isSideEffecting()` and `mayRunBeforePlannedTime()` declare phase semantics.
- Verify the provider's current documentation first and record the date and any discrepancies
  in [`providers/matrix.md`](providers/matrix.md). Contract-test against sanitized fixtures,
  and keep capabilities behind `RELAY_PROVIDER_*_ENABLED` until an authorized live smoke test passes.

## Testing strategy

| Layer       | Where                                                    | Notes                                                             |
| ----------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| Unit        | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | Pure logic, fast, no I/O                                          |
| Integration | `tests/integration/`                                     | Real Postgres/S3/FFmpeg, separate tenants per test, `ManualClock` |
| E2E         | `apps/web/e2e/`                                          | Production build, real worker, isolated database and bucket       |

Integration tests call services as different users and roles; drive the worker with
`drivePublishing()` (deterministic, clock-advancing) rather than sleeping.
