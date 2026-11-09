-- 0008 Operations: append-only audit log, idempotency records, usage metering and durable
-- user-facing job status.

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
  actor_user_id  uuid REFERENCES users (id),
  actor_label    text NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 120),
  action         text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,79}$'),
  entity_type    text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 60),
  entity_id      uuid,
  page_id        uuid,
  post_id        uuid,
  correlation_id text CHECK (length(correlation_id) <= 100),
  request_id     text CHECK (length(request_id) <= 100),
  -- Sanitised, minimal facts only: never tokens, signed URLs or provider payloads.
  data           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) < 8192),
  UNIQUE (workspace_id, id),
  CHECK (actor_type <> 'user' OR actor_user_id IS NOT NULL)
);
CREATE INDEX audit_events_entity_idx ON audit_events (workspace_id, entity_type, entity_id, occurred_at);
CREATE INDEX audit_events_post_idx ON audit_events (workspace_id, post_id, occurred_at) WHERE post_id IS NOT NULL;
CREATE INDEX audit_events_recent_idx ON audit_events (workspace_id, occurred_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_mutation();

CREATE TABLE idempotency_keys (
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation       text NOT NULL CHECK (length(operation) BETWEEN 1 AND 80),
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  actor_user_id   uuid REFERENCES users (id),
  request_hash    text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body   jsonb CHECK (response_body IS NULL OR pg_column_size(response_body) < 16384),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, operation, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE usage_events (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('upload_bytes', 'storage_bytes_released', 'media_seconds_processed',
                                             'provider_request', 'export_bytes')),
  quantity     numeric(20, 3) NOT NULL,
  entity_type  text,
  entity_id    uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX usage_events_kind_idx ON usage_events (workspace_id, kind, occurred_at);

CREATE TABLE job_runs (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,79}$'),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  progress       smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  error_code     text CHECK (length(error_code) <= 80),
  error_message  text CHECK (length(error_message) <= 500),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  correlation_id text CHECK (length(correlation_id) <= 100),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE INDEX job_runs_entity_idx ON job_runs (workspace_id, entity_type, entity_id, created_at DESC);
CREATE TRIGGER job_runs_touch BEFORE UPDATE ON job_runs
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

SELECT relay_apply_tenant_rls('audit_events');
SELECT relay_apply_tenant_rls('idempotency_keys');
SELECT relay_apply_tenant_rls('usage_events');
SELECT relay_apply_tenant_rls('job_runs');
SELECT relay_apply_maintenance_scan('idempotency_keys');

GRANT SELECT, INSERT ON audit_events TO relay_app, relay_worker;
GRANT SELECT, INSERT, DELETE ON idempotency_keys TO relay_app;
GRANT UPDATE (response_status, response_body) ON idempotency_keys TO relay_app;
GRANT SELECT, DELETE ON idempotency_keys TO relay_worker;
GRANT SELECT, INSERT ON usage_events TO relay_app, relay_worker;
GRANT SELECT, INSERT ON job_runs TO relay_app, relay_worker;
GRANT UPDATE (status, progress, error_code, error_message, attempts, updated_at, started_at, finished_at)
  ON job_runs TO relay_app, relay_worker;
