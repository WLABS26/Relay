-- 0009 Provider simulator: the deterministic stand-in for a remote platform used in demo mode
-- and tests. It lives in its own schema, is reachable only by the worker role, and is keyed by
-- provider account and operation IDs exactly like a real platform would be. Nothing here is a
-- real publication; every row is synthetic.

CREATE SCHEMA provider_sim;
REVOKE ALL ON SCHEMA provider_sim FROM PUBLIC;

CREATE TABLE provider_sim.remote_posts (
  id                         uuid PRIMARY KEY,
  provider                   text NOT NULL,
  account_ref                text NOT NULL,
  operation_id               text NOT NULL UNIQUE,
  external_id                text NOT NULL UNIQUE,
  container_id               text NOT NULL UNIQUE,
  status                     text NOT NULL CHECK (status IN ('staged', 'processing', 'published', 'rejected')),
  visibility                 text NOT NULL,
  format                     text NOT NULL,
  caption_sha256             text NOT NULL,
  media_count                integer NOT NULL CHECK (media_count > 0),
  processing_polls_remaining integer NOT NULL DEFAULT 0 CHECK (processing_polls_remaining >= 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  published_at               timestamptz
);
CREATE INDEX remote_posts_account_idx ON provider_sim.remote_posts (provider, account_ref);

-- Counts calls per operation and phase so "fail once" behaviours are deterministic.
CREATE TABLE provider_sim.call_counters (
  operation_id text NOT NULL,
  phase        text NOT NULL,
  calls        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (operation_id, phase)
);

GRANT USAGE ON SCHEMA provider_sim TO relay_worker;
GRANT SELECT, INSERT, UPDATE ON provider_sim.remote_posts, provider_sim.call_counters TO relay_worker;
