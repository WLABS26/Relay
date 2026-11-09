-- 0006 Publishing: posts, immutable revisions, per-destination lifecycle, approvals bound to
-- an intent hash, immutable publish intents, slot reservations, the publish attempt ledger
-- and confirmed external publications.

CREATE TABLE posts (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page_id             uuid NOT NULL,
  campaign_id         uuid,
  current_revision_id uuid,
  title               text CHECK (length(title) <= 200),
  is_sample           boolean NOT NULL DEFAULT false,
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, campaign_id) REFERENCES campaigns (workspace_id, id)
);
CREATE INDEX posts_page_recent_idx ON posts (workspace_id, page_id, created_at DESC, id DESC);
CREATE TRIGGER posts_touch BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE post_revisions (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  post_id         uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  title           text CHECK (length(title) <= 200),
  caption         text NOT NULL CHECK (length(caption) <= 5000),
  declarations    jsonb NOT NULL CHECK (jsonb_typeof(declarations) = 'object'),
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, revision_number),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts (workspace_id, id) ON DELETE CASCADE
);
CREATE TRIGGER post_revisions_immutable BEFORE UPDATE ON post_revisions
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_mutation();

ALTER TABLE posts ADD CONSTRAINT posts_current_revision_fkey
  FOREIGN KEY (workspace_id, current_revision_id) REFERENCES post_revisions (workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Ordered media of a revision (carousels keep their order; versions are pinned).
CREATE TABLE post_revision_media (
  workspace_id  uuid NOT NULL,
  revision_id   uuid NOT NULL,
  position      smallint NOT NULL CHECK (position >= 0 AND position < 20),
  asset_id      uuid NOT NULL,
  asset_version integer NOT NULL CHECK (asset_version > 0),
  PRIMARY KEY (revision_id, position),
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES media_assets (workspace_id, id)
);
CREATE INDEX post_revision_media_asset_idx ON post_revision_media (workspace_id, asset_id);
CREATE TRIGGER post_revision_media_immutable BEFORE UPDATE ON post_revision_media
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_mutation();

CREATE TABLE post_destinations (
  id                          uuid PRIMARY KEY,
  workspace_id                uuid NOT NULL,
  post_id                     uuid NOT NULL,
  page_destination_id         uuid NOT NULL,
  state                       text NOT NULL DEFAULT 'draft' CHECK (state IN (
                                'draft', 'needs_review', 'changes_requested', 'approved', 'scheduled',
                                'preparing', 'dispatching', 'processing', 'published', 'blocked',
                                'needs_reconciliation', 'failed', 'failed_permanent', 'expired', 'canceled')),
  state_reason                text CHECK (length(state_reason) <= 120),
  state_changed_at            timestamptz NOT NULL DEFAULT now(),
  active_intent_id            uuid,
  checkpoint_phase            text CHECK (checkpoint_phase IN ('prepare', 'transfer', 'wait_processing', 'dispatch', 'confirm')),
  checkpoint_receipt_id       text CHECK (length(checkpoint_receipt_id) <= 200),
  checkpoint_provider_post_id text CHECK (length(checkpoint_provider_post_id) <= 200),
  checkpoint_next_check_at    timestamptz,
  lease_owner                 text CHECK (length(lease_owner) <= 200),
  lease_token                 bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_expires_at            timestamptz,
  attempt_count               integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  version                     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, page_destination_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, page_destination_id) REFERENCES page_destinations (workspace_id, id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX post_destinations_state_idx ON post_destinations (workspace_id, state);
CREATE INDEX post_destinations_lease_idx ON post_destinations (lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE TRIGGER post_destinations_touch BEFORE UPDATE ON post_destinations
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

-- Per-destination copy of a revision plus the normalised intent payload and its hash.
CREATE TABLE post_revision_variants (
  workspace_id        uuid NOT NULL,
  revision_id         uuid NOT NULL,
  post_destination_id uuid NOT NULL,
  caption             text NOT NULL CHECK (length(caption) <= 5000),
  title               text CHECK (length(title) <= 200),
  visibility          text NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private', 'followers')),
  metadata            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  intent_payload      jsonb NOT NULL CHECK (pg_column_size(intent_payload) < 32768),
  intent_hash         text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  validation_issues   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(validation_issues) = 'array'),
  PRIMARY KEY (revision_id, post_destination_id),
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_destination_id) REFERENCES post_destinations (workspace_id, id) ON DELETE CASCADE
);
CREATE TRIGGER post_revision_variants_immutable BEFORE UPDATE ON post_revision_variants
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_mutation();

CREATE TABLE approvals (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL,
  post_destination_id uuid NOT NULL,
  revision_id         uuid NOT NULL,
  intent_hash         text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  decision            text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note                text CHECK (length(note) <= 1000),
  decided_by          uuid NOT NULL REFERENCES users (id),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  policy_revision     integer NOT NULL CHECK (policy_revision >= 0),
  window_starts_at    timestamptz,
  window_ends_at      timestamptz,
  invalidated_at      timestamptz,
  invalidated_reason  text CHECK (length(invalidated_reason) <= 120),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_destination_id) REFERENCES post_destinations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions (workspace_id, id),
  CHECK (window_starts_at IS NULL OR window_ends_at IS NULL OR window_starts_at < window_ends_at)
);
CREATE UNIQUE INDEX approvals_one_valid_key ON approvals (post_destination_id)
  WHERE decision = 'approved' AND invalidated_at IS NULL;

CREATE TABLE publish_intents (
  id                         uuid PRIMARY KEY,
  workspace_id               uuid NOT NULL,
  post_destination_id        uuid NOT NULL,
  revision_id                uuid NOT NULL,
  approval_id                uuid NOT NULL,
  intent_version             integer NOT NULL CHECK (intent_version > 0),
  operation_key              text NOT NULL UNIQUE CHECK (length(operation_key) <= 200),
  intent_hash                text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  dispatch_mode              text NOT NULL CHECK (dispatch_mode IN ('at', 'asap')),
  planned_at                 timestamptz NOT NULL,
  civil_local                text NOT NULL CHECK (civil_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  civil_zone                 text NOT NULL,
  civil_offset               text NOT NULL CHECK (civil_offset ~ '^[+-]\d{2}:\d{2}$'),
  page_pause_generation      integer NOT NULL,
  workspace_pause_generation integer NOT NULL,
  connection_generation      integer NOT NULL,
  policy_revision            integer NOT NULL,
  status                     text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'superseded', 'canceled', 'completed', 'failed')),
  created_by                 uuid REFERENCES users (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  ended_at                   timestamptz,
  end_reason                 text CHECK (length(end_reason) <= 120),
  UNIQUE (post_destination_id, intent_version),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_destination_id) REFERENCES post_destinations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions (workspace_id, id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals (workspace_id, id),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX publish_intents_one_active_key ON publish_intents (post_destination_id) WHERE status = 'active';
CREATE INDEX publish_intents_due_idx ON publish_intents (planned_at) WHERE status = 'active';

ALTER TABLE post_destinations ADD CONSTRAINT post_destinations_active_intent_fkey
  FOREIGN KEY (workspace_id, active_intent_id) REFERENCES publish_intents (workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Intent content is immutable; only its lifecycle columns may change.
CREATE FUNCTION relay_publish_intent_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.post_destination_id, NEW.revision_id, NEW.approval_id, NEW.intent_version, NEW.operation_key,
      NEW.intent_hash, NEW.dispatch_mode, NEW.planned_at, NEW.civil_local, NEW.civil_zone, NEW.civil_offset)
     IS DISTINCT FROM
     (OLD.post_destination_id, OLD.revision_id, OLD.approval_id, OLD.intent_version, OLD.operation_key,
      OLD.intent_hash, OLD.dispatch_mode, OLD.planned_at, OLD.civil_local, OLD.civil_zone, OLD.civil_offset) THEN
    RAISE EXCEPTION 'publish intents are immutable; create a new intent version' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'active' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'publish intent % already ended as %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER publish_intents_guard BEFORE UPDATE ON publish_intents
  FOR EACH ROW EXECUTE FUNCTION relay_publish_intent_guard();

CREATE TABLE slot_reservations (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL,
  social_account_id   uuid NOT NULL,
  page_destination_id uuid NOT NULL,
  post_destination_id uuid NOT NULL,
  intent_id           uuid NOT NULL,
  slot_at             timestamptz NOT NULL,
  locked              boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz,
  release_reason      text CHECK (length(release_reason) <= 120),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, page_destination_id) REFERENCES page_destinations (workspace_id, id),
  FOREIGN KEY (workspace_id, post_destination_id) REFERENCES post_destinations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, intent_id) REFERENCES publish_intents (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);
-- Backstop: one active reservation per exact slot on an account; pacing is checked under the
-- account row lock in the scheduling transaction.
CREATE UNIQUE INDEX slot_reservations_exact_slot_key ON slot_reservations (social_account_id, slot_at)
  WHERE status = 'active';
CREATE UNIQUE INDEX slot_reservations_one_active_key ON slot_reservations (post_destination_id)
  WHERE status = 'active';
CREATE INDEX slot_reservations_pacing_idx ON slot_reservations (social_account_id, slot_at)
  WHERE status IN ('active', 'consumed');
CREATE INDEX slot_reservations_calendar_idx ON slot_reservations (workspace_id, slot_at)
  WHERE status IN ('active', 'consumed');

CREATE TABLE publish_attempts (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL,
  post_destination_id uuid NOT NULL,
  intent_id           uuid NOT NULL,
  attempt_number      integer NOT NULL CHECK (attempt_number > 0),
  phase               text NOT NULL CHECK (phase IN ('prepare', 'transfer', 'wait_processing', 'dispatch', 'confirm', 'reconcile')),
  fencing_token       bigint NOT NULL,
  worker_id           text NOT NULL CHECK (length(worker_id) <= 200),
  operation_id        text NOT NULL CHECK (length(operation_id) <= 240),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  side_effecting      boolean NOT NULL,
  status              text NOT NULL DEFAULT 'in_flight' CHECK (status IN (
                        'in_flight', 'succeeded', 'waiting', 'retryable_error', 'rate_limited', 'rejected',
                        'unknown', 'stale', 'abandoned')),
  receipt_id          text CHECK (length(receipt_id) <= 200),
  provider_post_id    text CHECK (length(provider_post_id) <= 200),
  error_code          text CHECK (length(error_code) <= 80),
  error_message       text CHECK (length(error_message) <= 500),
  retry_after         timestamptz,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_destination_id) REFERENCES post_destinations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, intent_id) REFERENCES publish_intents (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'in_flight') = (finished_at IS NULL))
);
CREATE INDEX publish_attempts_destination_idx ON publish_attempts (workspace_id, post_destination_id, started_at DESC);
-- A destination never has two attempts in flight at once.
CREATE UNIQUE INDEX publish_attempts_one_in_flight_key ON publish_attempts (post_destination_id)
  WHERE status = 'in_flight';

CREATE TABLE external_publications (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL,
  post_destination_id   uuid NOT NULL UNIQUE,
  intent_id             uuid,
  social_account_id     uuid NOT NULL,
  provider              text NOT NULL CHECK (provider IN ('youtube', 'instagram', 'facebook_page', 'tiktok')),
  connection_mode       text NOT NULL CHECK (connection_mode IN ('simulated', 'live')),
  provider_account_id   text NOT NULL,
  external_id           text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  external_container_id text CHECK (length(external_container_id) <= 200),
  permalink             text CHECK (length(permalink) <= 2000),
  visibility            text NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private', 'followers')),
  format                text NOT NULL CHECK (format IN ('video', 'image', 'carousel')),
  planned_at            timestamptz,
  published_at          timestamptz NOT NULL,
  confirmed_at          timestamptz NOT NULL,
  link_method           text NOT NULL CHECK (link_method IN ('provider_confirmed', 'operator_linked', 'reconciled')),
  linked_by             uuid REFERENCES users (id),
  link_reason           text CHECK (length(link_reason) <= 1000),
  status                text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'removed')),
  is_sample             boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, social_account_id, external_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_destination_id) REFERENCES post_destinations (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, intent_id) REFERENCES publish_intents (workspace_id, id),
  FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts (workspace_id, id),
  CHECK (link_method <> 'operator_linked' OR (linked_by IS NOT NULL AND link_reason IS NOT NULL))
);
CREATE INDEX external_publications_recent_idx ON external_publications (workspace_id, published_at DESC);

SELECT relay_apply_tenant_rls('posts');
SELECT relay_apply_tenant_rls('post_revisions');
SELECT relay_apply_tenant_rls('post_revision_media');
SELECT relay_apply_tenant_rls('post_destinations');
SELECT relay_apply_tenant_rls('post_revision_variants');
SELECT relay_apply_tenant_rls('approvals');
SELECT relay_apply_tenant_rls('publish_intents');
SELECT relay_apply_tenant_rls('slot_reservations');
SELECT relay_apply_tenant_rls('publish_attempts');
SELECT relay_apply_tenant_rls('external_publications');
SELECT relay_apply_maintenance_scan('post_destinations');
SELECT relay_apply_maintenance_scan('publish_intents');

GRANT SELECT, INSERT ON posts TO relay_app;
GRANT UPDATE (current_revision_id, title, campaign_id, version, updated_at, archived_at) ON posts TO relay_app;
GRANT SELECT ON posts TO relay_worker;

GRANT SELECT, INSERT ON post_revisions, post_revision_media, post_revision_variants TO relay_app;
GRANT SELECT ON post_revisions, post_revision_media, post_revision_variants TO relay_worker;

GRANT SELECT, INSERT ON post_destinations TO relay_app;
GRANT UPDATE (state, state_reason, state_changed_at, active_intent_id, checkpoint_phase, checkpoint_receipt_id,
              checkpoint_provider_post_id, checkpoint_next_check_at, lease_owner, lease_token, lease_expires_at,
              attempt_count, version, updated_at)
  ON post_destinations TO relay_app, relay_worker;
GRANT SELECT ON post_destinations TO relay_worker;

GRANT SELECT, INSERT ON approvals TO relay_app;
GRANT UPDATE (invalidated_at, invalidated_reason) ON approvals TO relay_app, relay_worker;
GRANT SELECT ON approvals TO relay_worker;

GRANT SELECT, INSERT ON publish_intents TO relay_app;
GRANT UPDATE (status, ended_at, end_reason) ON publish_intents TO relay_app, relay_worker;
GRANT SELECT ON publish_intents TO relay_worker;

GRANT SELECT, INSERT ON slot_reservations TO relay_app;
GRANT UPDATE (status, released_at, release_reason, locked) ON slot_reservations TO relay_app;
GRANT SELECT ON slot_reservations TO relay_worker;
GRANT UPDATE (status, released_at, release_reason) ON slot_reservations TO relay_worker;

GRANT SELECT ON publish_attempts TO relay_app;
GRANT UPDATE (status, finished_at, error_code, error_message) ON publish_attempts TO relay_app;
GRANT SELECT, INSERT ON publish_attempts TO relay_worker;
GRANT UPDATE (status, receipt_id, provider_post_id, error_code, error_message, retry_after, finished_at)
  ON publish_attempts TO relay_worker;

GRANT SELECT, INSERT ON external_publications TO relay_app, relay_worker;
GRANT UPDATE (status) ON external_publications TO relay_worker;
