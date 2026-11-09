-- 0002 Identity and tenancy: users, sign-in, sessions, workspaces, memberships, invitations.
--
-- Users, identities and sessions are global (not tenant) records. They are still protected by
-- RLS: outside the bootstrap auth context a role only sees itself and co-members of the
-- current workspace.

CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized)),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at  timestamptz
);
CREATE UNIQUE INDEX users_email_normalized_key ON users (email_normalized);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE user_identities (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  issuer       text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  subject      text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (issuer, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- Opaque session tokens; only the SHA-256 hash is stored.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  auth_method     text NOT NULL CHECK (auth_method IN ('demo', 'oidc')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text CHECK (revoked_reason IN ('sign_out', 'rotated', 'expired', 'admin', 'user_disabled'))
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- OIDC sign-in attempts: one-time state, PKCE verifier (encrypted), nonce, return path.
CREATE TABLE auth_login_attempts (
  id                       uuid PRIMARY KEY,
  state_hash               bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  nonce                    text NOT NULL,
  code_verifier_ciphertext bytea NOT NULL,
  return_to                text NOT NULL CHECK (return_to LIKE '/%' AND return_to NOT LIKE '//%'),
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz
);
CREATE INDEX auth_login_attempts_expiry_idx ON auth_login_attempts (expires_at);

CREATE TABLE workspaces (
  id                  uuid PRIMARY KEY,
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  timezone            text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  week_start          text NOT NULL DEFAULT 'monday' CHECK (week_start IN ('monday', 'sunday')),
  locale              text NOT NULL DEFAULT 'en' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  is_demo             boolean NOT NULL DEFAULT false,
  storage_quota_bytes bigint NOT NULL CHECK (storage_quota_bytes > 0),
  paused_at           timestamptz,
  pause_reason        text CHECK (length(pause_reason) <= 280),
  pause_generation    integer NOT NULL DEFAULT 0 CHECK (pause_generation >= 0),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER workspaces_touch BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE workspace_memberships (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'publisher', 'editor', 'viewer')),
  all_pages    boolean NOT NULL DEFAULT true,
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id),
  UNIQUE (workspace_id, id),
  -- Owners and admins always see every page.
  CHECK (role NOT IN ('owner', 'admin') OR all_pages)
);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id);
CREATE TRIGGER workspace_memberships_touch BEFORE UPDATE ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

-- Backstop for last-owner protection. Domain commands lock the workspace row before checking;
-- this deferred trigger re-checks at commit (it also locks the workspace row, so concurrent
-- demotions serialise and the second one sees the first).
CREATE FUNCTION relay_ensure_workspace_owner() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  ws uuid := COALESCE(OLD.workspace_id, NEW.workspace_id);
BEGIN
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL; -- workspace itself is being deleted
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = ws AND role = 'owner') THEN
    RAISE EXCEPTION 'workspace % must keep at least one owner', ws
      USING ERRCODE = 'P0001', CONSTRAINT = 'workspace_last_owner';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER workspace_memberships_last_owner
  AFTER UPDATE OF role OR DELETE ON workspace_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION relay_ensure_workspace_owner();

CREATE TABLE invitations (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized)),
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'publisher', 'editor', 'viewer')),
  all_pages        boolean NOT NULL DEFAULT true,
  page_ids         uuid[] NOT NULL DEFAULT '{}',
  token_hash       bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_by      uuid REFERENCES users (id),
  revoked_at       timestamptz,
  UNIQUE (workspace_id, id),
  CHECK (role NOT IN ('owner', 'admin') OR all_pages),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX invitations_pending_email_key ON invitations (workspace_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ----- Row-level security --------------------------------------------------------------

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_read ON workspaces FOR SELECT USING (
  id = (SELECT relay_current_workspace_id())
  OR EXISTS (
    SELECT 1 FROM workspace_memberships m
    WHERE m.workspace_id = workspaces.id AND m.user_id = (SELECT relay_current_user_id())
  )
);
CREATE POLICY workspaces_insert ON workspaces FOR INSERT
  WITH CHECK (id = (SELECT relay_current_workspace_id()));
CREATE POLICY workspaces_update ON workspaces FOR UPDATE
  USING (id = (SELECT relay_current_workspace_id()))
  WITH CHECK (id = (SELECT relay_current_workspace_id()));
CREATE POLICY maintenance_scan ON workspaces FOR SELECT TO relay_worker
  USING ((SELECT relay_maintenance_scope()));

ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
-- A user can list their own memberships (workspace switcher) without a workspace context.
CREATE POLICY memberships_read ON workspace_memberships FOR SELECT USING (
  workspace_id = (SELECT relay_current_workspace_id())
  OR user_id = (SELECT relay_current_user_id())
);
CREATE POLICY memberships_write ON workspace_memberships
  USING (workspace_id = (SELECT relay_current_workspace_id()))
  WITH CHECK (workspace_id = (SELECT relay_current_workspace_id()));

SELECT relay_apply_tenant_rls('invitations');

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT USING (
  (SELECT relay_auth_bootstrap())
  OR id = (SELECT relay_current_user_id())
  OR EXISTS (
    SELECT 1 FROM workspace_memberships m
    WHERE m.user_id = users.id AND m.workspace_id = (SELECT relay_current_workspace_id())
  )
);
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK ((SELECT relay_auth_bootstrap()));
CREATE POLICY users_update ON users FOR UPDATE
  USING ((SELECT relay_auth_bootstrap()) OR id = (SELECT relay_current_user_id()))
  WITH CHECK ((SELECT relay_auth_bootstrap()) OR id = (SELECT relay_current_user_id()));

ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY user_identities_access ON user_identities
  USING ((SELECT relay_auth_bootstrap()) OR user_id = (SELECT relay_current_user_id()))
  WITH CHECK ((SELECT relay_auth_bootstrap()) OR user_id = (SELECT relay_current_user_id()));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_access ON sessions
  USING ((SELECT relay_auth_bootstrap()) OR user_id = (SELECT relay_current_user_id()))
  WITH CHECK ((SELECT relay_auth_bootstrap()) OR user_id = (SELECT relay_current_user_id()));

ALTER TABLE auth_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_login_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_login_attempts_access ON auth_login_attempts
  USING ((SELECT relay_auth_bootstrap()))
  WITH CHECK ((SELECT relay_auth_bootstrap()));

-- ----- Grants (least privilege; the worker never touches identity tables) ---------------

GRANT SELECT, INSERT ON users TO relay_app;
GRANT UPDATE (display_name, status, last_sign_in_at, updated_at) ON users TO relay_app;
GRANT SELECT, INSERT ON user_identities TO relay_app;
GRANT UPDATE (last_used_at) ON user_identities TO relay_app;
GRANT SELECT, INSERT ON sessions TO relay_app;
GRANT UPDATE (last_seen_at, idle_expires_at, revoked_at, revoked_reason) ON sessions TO relay_app;
GRANT SELECT, INSERT, DELETE ON auth_login_attempts TO relay_app;
GRANT UPDATE (consumed_at) ON auth_login_attempts TO relay_app;

GRANT SELECT, INSERT ON workspaces TO relay_app;
GRANT UPDATE (name, timezone, week_start, locale, paused_at, pause_reason, pause_generation, version, updated_at)
  ON workspaces TO relay_app;
GRANT SELECT ON workspaces TO relay_worker;
-- Row locks (FOR SHARE) during dispatch claims need UPDATE on at least one column.
GRANT UPDATE (updated_at) ON workspaces TO relay_worker;

GRANT SELECT, INSERT, DELETE ON workspace_memberships TO relay_app;
GRANT UPDATE (role, all_pages, version, updated_at) ON workspace_memberships TO relay_app;

GRANT SELECT, INSERT ON invitations TO relay_app;
GRANT UPDATE (accepted_at, accepted_by, revoked_at) ON invitations TO relay_app;
