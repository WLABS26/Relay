-- 0007 Results: metric definitions (global reference data), sync runs and observations.
--
-- Observations keep the definition, reporting window and observation time separately, carry
-- provenance and a source-policy class, and use nullable values with explicit availability:
-- a true zero is numeric zero. Upserts are keyed on a stable observation identity so repeated
-- cumulative snapshots are never summed.

CREATE TABLE metric_definitions (
  id                   uuid PRIMARY KEY,
  provider             text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  metric_key           text NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_.]{0,79}$'),
  definition_version   text NOT NULL CHECK (length(definition_version) BETWEEN 1 AND 40),
  unit                 text NOT NULL CHECK (unit IN ('count', 'seconds', 'ratio', 'currency')),
  aggregation          text NOT NULL CHECK (aggregation IN ('cumulative_snapshot', 'period_aggregate', 'estimate')),
  label                text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  description          text NOT NULL CHECK (length(description) <= 500),
  provider_api_version text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, metric_key, definition_version)
);
GRANT SELECT ON metric_definitions TO relay_app, relay_worker;

CREATE TABLE metric_sync_runs (
  id                      uuid PRIMARY KEY,
  workspace_id            uuid NOT NULL,
  external_publication_id uuid NOT NULL,
  age_bucket              text CHECK (age_bucket IN ('24h', '72h', '7d', '30d')),
  status                  text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  provenance              text NOT NULL CHECK (provenance IN ('simulator', 'provider_api')),
  error_code              text CHECK (length(error_code) <= 80),
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, external_publication_id)
    REFERENCES external_publications (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE metric_observations (
  id                      uuid PRIMARY KEY,
  workspace_id            uuid NOT NULL,
  external_publication_id uuid NOT NULL,
  metric_definition_id    uuid NOT NULL REFERENCES metric_definitions (id),
  observation_key         text NOT NULL CHECK (length(observation_key) <= 80),
  age_bucket              text CHECK (age_bucket IN ('24h', '72h', '7d', '30d')),
  period_start            timestamptz,
  period_end              timestamptz,
  provider_date_zone      text,
  observed_at             timestamptz NOT NULL,
  published_at            timestamptz NOT NULL,
  value                   numeric(20, 4),
  availability            text NOT NULL CHECK (availability IN (
                            'available', 'not_supported', 'missing_scope', 'not_yet_reported', 'expired',
                            'rate_limited', 'suppressed')),
  provenance              text NOT NULL CHECK (provenance IN ('simulator', 'provider_api', 'user_entry', 'computed')),
  source_policy           text NOT NULL CHECK (length(source_policy) BETWEEN 1 AND 80),
  source_endpoint         text CHECK (length(source_endpoint) <= 200),
  sync_run_id             uuid,
  revision                integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  revised_at              timestamptz,
  expires_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_publication_id, metric_definition_id, observation_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, external_publication_id)
    REFERENCES external_publications (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, sync_run_id) REFERENCES metric_sync_runs (workspace_id, id),
  CHECK ((availability = 'available') = (value IS NOT NULL)),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_start < period_end)
);
CREATE INDEX metric_observations_publication_idx ON metric_observations (workspace_id, external_publication_id);

SELECT relay_apply_tenant_rls('metric_sync_runs');
SELECT relay_apply_tenant_rls('metric_observations');

GRANT SELECT ON metric_sync_runs, metric_observations TO relay_app;
GRANT SELECT, INSERT ON metric_sync_runs, metric_observations TO relay_worker;
GRANT UPDATE (status, error_code, finished_at) ON metric_sync_runs TO relay_worker;
GRANT UPDATE (value, availability, observed_at, sync_run_id, revision, revised_at, expires_at)
  ON metric_observations TO relay_worker;

-- Metric definitions used by the provider simulator. Real provider definitions are added
-- with their adapters (M3+) after verifying the provider documentation.
INSERT INTO metric_definitions (id, provider, metric_key, definition_version, unit, aggregation, label, description) VALUES
  ('018f0000-0000-7000-8000-000000000001', 'simulator', 'views', 'sim-1', 'count', 'cumulative_snapshot',
   'Views (simulated)', 'Simulated cumulative view count. Synthetic data for demos and tests only.'),
  ('018f0000-0000-7000-8000-000000000002', 'simulator', 'watch_time_seconds', 'sim-1', 'seconds', 'cumulative_snapshot',
   'Watch time (simulated)', 'Simulated cumulative watch time in seconds. Synthetic data only.'),
  ('018f0000-0000-7000-8000-000000000003', 'simulator', 'followers_gained', 'sim-1', 'count', 'cumulative_snapshot',
   'Followers gained (simulated)', 'Simulated followers attributed to the post. Synthetic data only.'),
  ('018f0000-0000-7000-8000-000000000004', 'simulator', 'interactions', 'sim-1', 'count', 'cumulative_snapshot',
   'Interactions (simulated)', 'Simulated likes, comments and shares combined. Synthetic data only.'),
  ('018f0000-0000-7000-8000-000000000005', 'simulator', 'saves', 'sim-1', 'count', 'cumulative_snapshot',
   'Saves (simulated)', 'Simulated saves; some simulated destinations do not report it.');
