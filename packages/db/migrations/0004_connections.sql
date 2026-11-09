-- 0004 Connections: provider grants, connected social accounts, capability snapshots and the
-- page destinations that target them.
--
-- A grant can authorise several accounts. Credentials are envelope-encrypted ciphertext bound
-- (via AEAD associated data) to workspace, provider and grant ID; simulated grants carry none.
-- page_destinations are immutable in their target: the app role may only update presentation
-- columns, never social_account_id or provider (column-level privileges).

CREATE TABLE provider_grants (
  id                       uuid PRIMARY KEY,
  workspace_id             uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider                 text NOT NULL
                           CHECK (provider IN ('youtube', 'instagram', 'facebook_page', 'tiktok', 'twitch')),
  connection_mode          text NOT NULL CHECK (connection_mode IN ('simulated', 'live')),
  connection_variant       text NOT NULL DEFAULT 'default' CHECK (length(connection_variant) <= 40),
  granted_scopes           text[] NOT NULL DEFAULT '{}',
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'revoked')),
  access_token_ciphertext  bytea,
  refresh_token_ciphertext bytea,
  access_expires_at        timestamptz,
  refresh_expires_at       timestamptz,
  token_version            integer NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  refresh_lease_owner      text,
  refresh_lease_expires_at timestamptz,
  created_by               uuid NOT NULL REFERENCES users (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  UNIQUE (workspace_id, id),
  CHECK (connection_mode = 'live' OR (access_token_ciphertext IS NULL AND refresh_token_ciphertext IS NULL))
);
CREATE TRIGGER provider_grants_touch BEFORE UPDATE ON provider_grants
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE social_accounts (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  grant_id              uuid NOT NULL,
  provider              text NOT NULL
                        CHECK (provider IN ('youtube', 'instagram', 'facebook_page', 'tiktok', 'twitch')),
  connection_mode       text NOT NULL CHECK (connection_mode IN ('simulated', 'live')),
  provider_account_id   text NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 200),
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  handle                text CHECK (length(handle) <= 120),
  account_type          text NOT NULL CHECK (length(account_type) BETWEEN 1 AND 40),
  simulator_profile     text CHECK (simulator_profile IN ('reliable', 'slow_processing', 'rate_limited_once',
                                                          'transient_then_ok', 'lost_response', 'ambiguous',
                                                          'reject_format')),
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'needs_reauth', 'revoked', 'disconnected')),
  health_reason         text CHECK (length(health_reason) <= 120),
  health_checked_at     timestamptz,
  connection_generation integer NOT NULL DEFAULT 0 CHECK (connection_generation >= 0),
  created_by            uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz,
  UNIQUE (workspace_id, provider, provider_account_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, grant_id) REFERENCES provider_grants (workspace_id, id),
  CHECK ((connection_mode = 'simulated') = (simulator_profile IS NOT NULL))
);
CREATE TRIGGER social_accounts_touch BEFORE UPDATE ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE provider_capabilities (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL,
  social_account_id uuid NOT NULL,
  capability        text NOT NULL CHECK (length(capability) BETWEEN 1 AND 60),
  state             text NOT NULL
                    CHECK (state IN ('enabled', 'disabled', 'missing_scope', 'needs_review', 'not_supported')),
  reason_code       text CHECK (length(reason_code) <= 200),
  checked_at        timestamptz NOT NULL,
  UNIQUE (social_account_id, capability),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE page_destinations (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  page_id            uuid NOT NULL,
  social_account_id  uuid NOT NULL,
  provider           text NOT NULL
                     CHECK (provider IN ('youtube', 'instagram', 'facebook_page', 'tiktok')),
  label              text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  default_visibility text NOT NULL DEFAULT 'public'
                     CHECK (default_visibility IN ('public', 'unlisted', 'private', 'followers')),
  enabled            boolean NOT NULL DEFAULT true,
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts (workspace_id, id)
);
CREATE UNIQUE INDEX page_destinations_active_key ON page_destinations (page_id, social_account_id)
  WHERE archived_at IS NULL;
CREATE TRIGGER page_destinations_touch BEFORE UPDATE ON page_destinations
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

SELECT relay_apply_tenant_rls('provider_grants');
SELECT relay_apply_tenant_rls('social_accounts');
SELECT relay_apply_tenant_rls('provider_capabilities');
SELECT relay_apply_tenant_rls('page_destinations');

GRANT SELECT, INSERT ON provider_grants TO relay_app;
GRANT UPDATE (granted_scopes, status, access_token_ciphertext, refresh_token_ciphertext, access_expires_at,
              refresh_expires_at, token_version, updated_at, revoked_at)
  ON provider_grants TO relay_app;
GRANT SELECT ON provider_grants TO relay_worker;
GRANT UPDATE (status, access_token_ciphertext, refresh_token_ciphertext, access_expires_at, refresh_expires_at,
              token_version, refresh_lease_owner, refresh_lease_expires_at, updated_at)
  ON provider_grants TO relay_worker;

GRANT SELECT, INSERT ON social_accounts TO relay_app;
GRANT UPDATE (display_name, handle, status, health_reason, health_checked_at, connection_generation,
              updated_at, disconnected_at)
  ON social_accounts TO relay_app;
GRANT SELECT ON social_accounts TO relay_worker;
GRANT UPDATE (status, health_reason, health_checked_at, updated_at) ON social_accounts TO relay_worker;

GRANT SELECT, INSERT, UPDATE ON provider_capabilities TO relay_app, relay_worker;

GRANT SELECT, INSERT ON page_destinations TO relay_app;
GRANT UPDATE (label, default_visibility, enabled, updated_at, archived_at) ON page_destinations TO relay_app;
GRANT SELECT ON page_destinations TO relay_worker;
