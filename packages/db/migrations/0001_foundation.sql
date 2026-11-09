-- 0001 Foundation: schema privileges, tenant-context helpers, shared trigger functions.
--
-- Tenant context is transaction-local (set_config(..., true)), so a pooled connection never
-- carries one tenant's context into the next transaction. Policies call the helpers through
-- a scalar sub-select so Postgres evaluates them once per statement (InitPlan).

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO relay_app, relay_worker;

CREATE FUNCTION relay_current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('relay.workspace_id', true), '')::uuid $$;

CREATE FUNCTION relay_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('relay.user_id', true), '')::uuid $$;

-- Set only by the sign-in / session-validation code paths before a user is known.
CREATE FUNCTION relay_auth_bootstrap() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(current_setting('relay.auth_context', true), '') = 'bootstrap' $$;

-- Set only by worker maintenance scans; policies using it are restricted TO relay_worker
-- and FOR SELECT, so it can reveal due-work identifiers but never write across tenants.
CREATE FUNCTION relay_maintenance_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(current_setting('relay.scope', true), '') = 'maintenance' $$;

REVOKE ALL ON FUNCTION relay_current_workspace_id(), relay_current_user_id(),
  relay_auth_bootstrap(), relay_maintenance_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_current_workspace_id(), relay_current_user_id(),
  relay_auth_bootstrap(), relay_maintenance_scope() TO relay_app, relay_worker;

-- Standard tenant isolation for a table with a NOT NULL workspace_id column.
CREATE FUNCTION relay_apply_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (workspace_id = (SELECT relay_current_workspace_id()))
       WITH CHECK (workspace_id = (SELECT relay_current_workspace_id()))',
    tbl);
END
$$;
REVOKE ALL ON FUNCTION relay_apply_tenant_rls(regclass) FROM PUBLIC;

-- Read-only cross-tenant visibility for the worker's maintenance scans.
CREATE FUNCTION relay_apply_maintenance_scan(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format(
    'CREATE POLICY maintenance_scan ON %s FOR SELECT TO relay_worker
       USING ((SELECT relay_maintenance_scope()))',
    tbl);
END
$$;
REVOKE ALL ON FUNCTION relay_apply_maintenance_scan(regclass) FROM PUBLIC;

CREATE FUNCTION relay_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION relay_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (%)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001', HINT = 'Create a new revision instead.';
END
$$;

CREATE TABLE relay_schema_info (
  key text PRIMARY KEY,
  value text NOT NULL
);
GRANT SELECT ON relay_schema_info TO relay_app, relay_worker;
