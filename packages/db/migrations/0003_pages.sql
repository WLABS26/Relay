-- 0003 Pages: logical pages, immutable publishing-policy revisions, page-scoped access,
-- campaigns. Every tenant table carries workspace_id and a UNIQUE (workspace_id, id) key so
-- composite foreign keys make cross-tenant references impossible.

CREATE TABLE pages (
  id                      uuid PRIMARY KEY,
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name                    text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  timezone                text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  week_start              text NOT NULL DEFAULT 'monday' CHECK (week_start IN ('monday', 'sunday')),
  goal                    text NOT NULL DEFAULT 'views'
                          CHECK (goal IN ('views', 'watch_time', 'followers', 'conversions', 'revenue')),
  topics                  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(topics) <= 20),
  content_pillars         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(content_pillars) <= 20),
  allowed_formats         text[] NOT NULL DEFAULT '{video,image,carousel}'
                          CHECK (allowed_formats <@ ARRAY['video', 'image', 'carousel']::text[]
                                 AND cardinality(allowed_formats) > 0),
  is_sample               boolean NOT NULL DEFAULT false,
  current_policy_revision integer NOT NULL DEFAULT 0 CHECK (current_policy_revision >= 0),
  paused_at               timestamptz,
  paused_by               uuid REFERENCES users (id),
  pause_reason            text CHECK (length(pause_reason) <= 280),
  pause_generation        integer NOT NULL DEFAULT 0 CHECK (pause_generation >= 0),
  version                 integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  archived_at             timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE INDEX pages_workspace_idx ON pages (workspace_id, name);
CREATE TRIGGER pages_touch BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE page_policy_revisions (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  page_id      uuid NOT NULL,
  revision     integer NOT NULL CHECK (revision > 0),
  rules        jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, revision),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE
);
CREATE TRIGGER page_policy_revisions_immutable BEFORE UPDATE ON page_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_mutation();

-- Explicit page grants for members whose membership is not all_pages.
CREATE TABLE membership_pages (
  workspace_id  uuid NOT NULL,
  membership_id uuid NOT NULL,
  page_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, page_id),
  FOREIGN KEY (workspace_id, membership_id)
    REFERENCES workspace_memberships (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX membership_pages_page_idx ON membership_pages (workspace_id, page_id);

CREATE TABLE campaigns (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page_id      uuid,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  starts_on    date,
  ends_on      date,
  is_sample    boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL REFERENCES users (id),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE,
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
);
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

SELECT relay_apply_tenant_rls('pages');
SELECT relay_apply_tenant_rls('page_policy_revisions');
SELECT relay_apply_tenant_rls('membership_pages');
SELECT relay_apply_tenant_rls('campaigns');
SELECT relay_apply_maintenance_scan('pages');

GRANT SELECT, INSERT ON pages TO relay_app;
GRANT UPDATE (name, timezone, week_start, goal, topics, content_pillars, allowed_formats,
              current_policy_revision, paused_at, paused_by, pause_reason, pause_generation,
              version, updated_at, archived_at)
  ON pages TO relay_app;
GRANT SELECT ON pages TO relay_worker;
GRANT UPDATE (updated_at) ON pages TO relay_worker; -- FOR SHARE locks during dispatch claims

GRANT SELECT, INSERT ON page_policy_revisions TO relay_app;
GRANT SELECT ON page_policy_revisions TO relay_worker;

GRANT SELECT, INSERT, DELETE ON membership_pages TO relay_app;

GRANT SELECT, INSERT ON campaigns TO relay_app;
GRANT UPDATE (name, starts_on, ends_on, version, updated_at, archived_at) ON campaigns TO relay_app;
GRANT SELECT ON campaigns TO relay_worker;
