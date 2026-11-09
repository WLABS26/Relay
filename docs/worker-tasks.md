# Worker task catalog

Source of truth: `packages/services/src/tasks.ts` (identifiers, pools, payload schemas,
attempt limits) and `apps/worker/src/main.ts` (pools and cron). Every payload is a minimal ID
pointer validated on enqueue and on receipt. Handlers reload authoritative state from
Postgres and treat each payload as a hint that may be stale, duplicated or out of order.
Jobs are enqueued inside the business transaction (`relay_enqueue_job`), so a rolled-back
change never leaves a job behind.

## Pools

| Pool      | Tasks                                               | Concurrency                    | Why separate                                  |
| --------- | --------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `general` | publish, reconcile, metrics, maintenance (and cron) | `RELAY_WORKER_CONCURRENCY` (4) | Latency-sensitive publishing                  |
| `media`   | `asset.probe`                                       | `RELAY_MEDIA_CONCURRENCY` (1)  | Long FFmpeg runs must never starve publishing |

`RELAY_WORKER_POOLS` selects pools per process (both locally; one per container in production).

## Tasks

| Task                         | Pool    | Payload                                                   | Max attempts | Job key                    | What it does                                                                                                                                                                                                                                                    |
| ---------------------------- | ------- | --------------------------------------------------------- | ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset.probe`                | media   | `workspaceId, assetId, uploadSessionId`                   | 3            | per asset                  | Downloads the exact object version, enforces size and checksum, sniffs the container, scans for protection, probes with ffprobe, validates, renders thumbnail (and proxy for video), marks the asset ready or rejected (deleting stored bytes)                  |
| `publish.advance`            | general | `workspaceId, postDestinationId, intentId, intentVersion` | 5            | per destination            | One provider phase per run (prepare → transfer → wait_processing → dispatch → confirm) under a fenced lease; writes the attempt row before any side effect; defers on waiting/rate limits; blocks on pause, kill switch, rights, approval or capability changes |
| `publish.reconcile`          | general | `workspaceId, postDestinationId, intentId`                | 5            | `reconcile:<destination>`  | Resolves unknown outcomes by idempotent provider lookup: published → confirm; proven not sent → resume; indeterminate → operator review                                                                                                                         |
| `metrics.refresh`            | general | `workspaceId, externalPublicationId, ageBucket`           | 5            | per publication and bucket | Reads metrics at 24 h / 72 h / 7 d / 30 d, recording availability (`not_yet_reported`, `not_supported`, `missing_scope`) instead of zeros                                                                                                                       |
| `maintenance.reconcile_due`  | general | —                                                         | 1            | `cron_reconcile_due`       | Every minute: re-drives destinations whose lease expired or whose due work shows no progress                                                                                                                                                                    |
| `maintenance.expire_uploads` | general | —                                                         | 1            | `cron_expire_uploads`      | Every 10 minutes: expires abandoned upload sessions, releases quota, aborts multipart uploads and deletes partial objects                                                                                                                                       |
| `maintenance.cleanup`        | general | —                                                         | 1            | `cron_cleanup`             | Hourly at :17: removes expired idempotency records                                                                                                                                                                                                              |

Queue-level attempts only cover crashes and re-delivery; publish retries are governed by
Relay's own attempt ledger (an attempt plus at most five consecutive retries on retryable or rate-limited results, with
exponential backoff or the provider's Retry-After, before `failed`).

## Inspecting jobs

- **API:** `GET /api/v1/workspaces/:workspaceId/jobs/:jobId` returns a job's status for members.
- **Database** (operators): `graphile_worker.jobs` holds queued and failed jobs (`last_error`,
  `attempts`, `run_at`, `locked_by`); `publish_attempts` is Relay's per-destination ledger.
- **Logs:** structured JSON per task (`task`, `jobId`, `ms`, `outcome` or `err`).
- **Health:** `GET /healthz` (liveness) and `GET /readyz` (database reachable, not draining) on
  `RELAY_WORKER_HEALTH_PORT` (3101).
