# Operations runbook

Covers health, jobs, failure recovery, media cleanup and moving from demo to a real test
account (spec §14). Production deploys and migrations are always separate, explicit operator
actions.

## Health and readiness

| Process | Liveness                                            | Readiness                                                                                                                    |
| ------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Web     | `GET /api/health` → `{"ok":true}`                   | `GET /api/ready`: database at the required schema version **and** storage reachable; 503 otherwise, cause logged server-side |
| Worker  | `GET /healthz` on `RELAY_WORKER_HEALTH_PORT` (3101) | `GET /readyz`: database reachable and not draining                                                                           |

Liveness never depends on the database, so an outage does not trigger restart loops. The worker
binds its probe to `RELAY_WORKER_HEALTH_HOST` (`127.0.0.1` by default; set `0.0.0.0` when probed
over the network). Both images define Docker `HEALTHCHECK`s.

Both processes refuse to start (exit 78, `EX_CONFIG`) on invalid configuration and print every
problem. The worker also refuses a database older than the required schema version.

## Inspecting jobs

See [`docs/worker-tasks.md`](../worker-tasks.md). In short:

```sql
-- queued, scheduled and failing jobs
SELECT id, task_identifier, run_at, attempts, max_attempts, last_error, locked_by
FROM graphile_worker.jobs ORDER BY run_at LIMIT 50;
-- Relay's own attempt ledger for one destination
SELECT attempt_number, phase, status, started_at, finished_at, error_code
FROM publish_attempts WHERE post_destination_id = '<id>' ORDER BY started_at;
```

Run tenant-table queries as an operator role with the tenant context set; forced RLS returns no
rows otherwise, even to the table owner.

## Failure recovery

| Situation                                                       | What Relay does                                                                                                                                                   | Operator action                                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider outcome unknown (timeout after dispatch)               | Destination moves to _Outcome unknown_; `publish.reconcile` looks the post up idempotently                                                                        | None if reconciliation proves the outcome. If indeterminate, open **Inbox**, check the platform, then **Link external post** or **Close as not published** (owner/admin) |
| Retries exhausted (repeated 429/5xx)                            | Destination moves to _Failed_ after five consecutive retryable attempts; nothing was dispatched                                                                   | **Retry** (publisher+) once the platform recovers                                                                                                                        |
| Worker crash or partition                                       | The lease expires; `maintenance.reconcile_due` re-drives it within a minute; the fenced lease prevents the old worker from writing                                | None                                                                                                                                                                     |
| Rights, approval, connection or capability changed              | Dispatch is blocked with a reason before any side effect                                                                                                          | Fix the cause, re-approve if the content changed, then resume                                                                                                            |
| Emergency stop                                                  | `RELAY_PUBLISH_KILL_SWITCH=true` holds every dispatch globally; pausing a page or workspace blocks new dispatches there (in-flight posts finish and are reported) | Unset or resume when safe                                                                                                                                                |
| Planned time missed beyond `RELAY_SCHEDULER_LATE_GRACE_SECONDS` | Blocked as _missed schedule_ instead of publishing late                                                                                                           | Reschedule                                                                                                                                                               |

## Media cleanup

- Rejected uploads: every stored version of the object is deleted at rejection time.
- Abandoned uploads: `maintenance.expire_uploads` (every 10 minutes) expires sessions past
  `RELAY_UPLOAD_SESSION_TTL_SECONDS`, aborts multipart uploads, deletes partial objects and
  releases the quota reservation.
- Worker scratch files live in a per-job directory under `RELAY_MEDIA_SCRATCH_DIR` (default the
  OS temp dir) and are removed when the job ends; size the media container's `/tmp` for the
  largest accepted upload.
- Retention of published media and derived files is a policy decision scheduled for M7.

## Database migrations (operator action)

```bash
# local
pnpm db:migrate
# container image (same SQL, bundled runner)
docker run --rm --env-file relay.env relay-worker node dist/migrate.js
```

Migrations take an advisory lock, refuse edited applied files (checksums), and pin the
Graphile Worker schema revision. Web and worker refuse to run against an older schema.
`pnpm db:reset` recreates the local database (local/test only) and explains which processes
still hold it if it cannot.

## Switching from demo to a test account

Not possible in this build: real adapters start with M3 (YouTube). When an adapter lands:

1. Register the OAuth client in the provider console with the exact redirect URL
   (operator action) and store its credentials in the secrets manager.
2. Set the provider's flag, e.g. `RELAY_PROVIDER_YOUTUBE_ENABLED=true`, in staging only.
3. Connect a **test** account under Settings → Connections and keep visibility private.
4. Run the authorized smoke test, then record the result as _live-verified_ in
   `docs/providers/matrix.md`.

Turning `RELAY_DEMO_MODE` off removes demo sign-in and disables simulated connections
immediately; their scheduled posts are blocked as _Simulated connections are disabled_
rather than silently routed to a real platform.
