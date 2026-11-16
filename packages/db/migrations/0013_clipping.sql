-- 0013 Clipping: analysis of a source recording, ranked clip candidates, non-destructive clip
-- edits and render jobs that produce derived assets.
--
-- A clip never alters its source. A clip project points at a source asset and a current
-- revision; revisions are immutable (range, aspect, crop, captions). A render job turns one
-- revision into a new media_assets row with origin = 'render'. Derived assets hold no rights
-- of their own: their rights are the source's, resolved through render_jobs.

CREATE TABLE media_analyses (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL,
  asset_version    integer NOT NULL CHECK (asset_version > 0),
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  analyzer_version text NOT NULL CHECK (length(analyzer_version) BETWEEN 1 AND 60),
  ranker_version   text NOT NULL CHECK (length(ranker_version) BETWEEN 1 AND 60),
  input_variant    text NOT NULL DEFAULT 'proxy' CHECK (input_variant IN ('proxy', 'original')),
  duration_ms      integer CHECK (duration_ms > 0),
  has_audio        boolean,
  -- Share of the timeline that produced usable features; low coverage must not look certain.
  coverage         numeric(4, 3) CHECK (coverage BETWEEN 0 AND 1),
  -- Downsampled loudness envelope for the editor's timeline (at most 2000 points).
  envelope         jsonb CHECK (envelope IS NULL OR pg_column_size(envelope) < 65536),
  summary          jsonb CHECK (summary IS NULL OR pg_column_size(summary) < 8192),
  error_code       text CHECK (length(error_code) <= 60),
  error_detail     text CHECK (length(error_detail) <= 500),
  requested_by     uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES media_assets (workspace_id, id) ON DELETE CASCADE,
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX media_analyses_asset_idx ON media_analyses (workspace_id, asset_id, created_at DESC);
-- One live analysis per asset and analyzer/ranker version; a failed one can be retried.
CREATE UNIQUE INDEX media_analyses_active_idx
  ON media_analyses (asset_id, analyzer_version, ranker_version)
  WHERE status IN ('queued', 'running', 'succeeded');
CREATE TRIGGER media_analyses_touch BEFORE UPDATE ON media_analyses
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE clip_candidates (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  analysis_id    uuid NOT NULL,
  asset_id       uuid NOT NULL,
  rank           integer NOT NULL CHECK (rank > 0),
  -- Milliseconds on the 0-based media timeline; start inclusive, end exclusive.
  start_ms       integer NOT NULL CHECK (start_ms >= 0),
  end_ms         integer NOT NULL,
  score          numeric(5, 4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  confidence     numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  evidence       jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(evidence) < 4096),
  ranker_version text NOT NULL CHECK (length(ranker_version) BETWEEN 1 AND 60),
  -- Reviewer feedback is Relay first-party data.
  feedback       text CHECK (feedback IN ('accepted', 'trim_adjusted', 'missing_context', 'wrong_fit', 'rights_issue')),
  feedback_by    uuid REFERENCES users (id),
  feedback_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (analysis_id, rank),
  FOREIGN KEY (workspace_id, analysis_id) REFERENCES media_analyses (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES media_assets (workspace_id, id) ON DELETE CASCADE,
  CHECK (end_ms > start_ms),
  CHECK ((feedback IS NULL) = (feedback_by IS NULL) AND (feedback IS NULL) = (feedback_at IS NULL))
);
CREATE INDEX clip_candidates_asset_idx ON clip_candidates (workspace_id, asset_id, rank);

CREATE TABLE clip_projects (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page_id              uuid NOT NULL,
  source_asset_id      uuid NOT NULL,
  source_asset_version integer NOT NULL CHECK (source_asset_version > 0),
  candidate_id         uuid,
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- Set right after the first revision is inserted, in the same transaction.
  current_revision_id  uuid,
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by           uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_asset_id) REFERENCES media_assets (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, candidate_id) REFERENCES clip_candidates (workspace_id, id) ON DELETE SET NULL (candidate_id)
);
CREATE INDEX clip_projects_source_idx ON clip_projects (workspace_id, source_asset_id, created_at DESC);
CREATE INDEX clip_projects_page_idx ON clip_projects (workspace_id, page_id, created_at DESC);
CREATE TRIGGER clip_projects_touch BEFORE UPDATE ON clip_projects
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

CREATE TABLE clip_revisions (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  clip_id         uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  start_ms        integer NOT NULL CHECK (start_ms >= 0),
  end_ms          integer NOT NULL,
  aspect          text NOT NULL CHECK (aspect IN ('9:16', '1:1', 'original')),
  crop_mode       text NOT NULL CHECK (crop_mode IN ('fit', 'fill')),
  -- Validated caption cues relative to the clip start; null means no captions.
  captions        jsonb CHECK (captions IS NULL OR pg_column_size(captions) < 131072),
  caption_style   text NOT NULL DEFAULT 'default' CHECK (caption_style IN ('default')),
  -- Hash of the normalised edit; equal edits render to the same key.
  edit_hash       text NOT NULL CHECK (edit_hash ~ '^[0-9a-f]{64}$'),
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (clip_id, revision_number),
  FOREIGN KEY (workspace_id, clip_id) REFERENCES clip_projects (workspace_id, id) ON DELETE CASCADE,
  CHECK (end_ms > start_ms)
);
CREATE TRIGGER clip_revisions_immutable BEFORE UPDATE ON clip_revisions
  FOR EACH ROW EXECUTE FUNCTION relay_forbid_mutation();
ALTER TABLE clip_projects
  ADD FOREIGN KEY (workspace_id, current_revision_id) REFERENCES clip_revisions (workspace_id, id);

CREATE TABLE render_jobs (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  clip_id               uuid NOT NULL,
  revision_id           uuid NOT NULL,
  profile               text NOT NULL CHECK (profile IN ('mp4-h264-aac')),
  -- sha256 of source object version + edit hash + profile + renderer version.
  render_key            text NOT NULL CHECK (render_key ~ '^[0-9a-f]{64}$'),
  status                text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  source_asset_id       uuid NOT NULL,
  source_asset_version  integer NOT NULL CHECK (source_asset_version > 0),
  -- The source's rights_version when the render was requested; re-checked by the worker.
  source_rights_version integer NOT NULL CHECK (source_rights_version >= 0),
  output_asset_id       uuid NOT NULL UNIQUE,
  renderer_version      text CHECK (length(renderer_version) <= 120),
  output_probe          jsonb CHECK (output_probe IS NULL OR pg_column_size(output_probe) < 16384),
  render_ms             integer CHECK (render_ms >= 0),
  error_code            text CHECK (length(error_code) <= 60),
  error_detail          text CHECK (length(error_detail) <= 500),
  requested_by          uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, clip_id) REFERENCES clip_projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES clip_revisions (workspace_id, id),
  FOREIGN KEY (workspace_id, source_asset_id) REFERENCES media_assets (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, output_asset_id) REFERENCES media_assets (workspace_id, id) ON DELETE CASCADE,
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX render_jobs_clip_idx ON render_jobs (workspace_id, clip_id, created_at DESC);
CREATE INDEX render_jobs_source_idx ON render_jobs (workspace_id, source_asset_id);
-- One live or successful derivative per render key: an identical edit is rendered once.
CREATE UNIQUE INDEX render_jobs_key_idx
  ON render_jobs (workspace_id, render_key)
  WHERE status IN ('queued', 'running', 'succeeded');
CREATE TRIGGER render_jobs_touch BEFORE UPDATE ON render_jobs
  FOR EACH ROW EXECUTE FUNCTION relay_touch_updated_at();

-- A change to a source's rights also makes every approval of its clips stale: bump the
-- rights_version of each asset rendered from it (same mechanism as relay_bump_rights_version).
CREATE FUNCTION relay_bump_derived_rights_version() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE media_assets a SET rights_version = a.rights_version + 1
    FROM render_jobs r
   WHERE r.workspace_id = NEW.workspace_id AND r.source_asset_id = NEW.asset_id
     AND a.workspace_id = r.workspace_id AND a.id = r.output_asset_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER source_rights_grants_bump_derived AFTER INSERT OR UPDATE ON source_rights_grants
  FOR EACH ROW EXECUTE FUNCTION relay_bump_derived_rights_version();

SELECT relay_apply_tenant_rls('media_analyses');
SELECT relay_apply_tenant_rls('clip_candidates');
SELECT relay_apply_tenant_rls('clip_projects');
SELECT relay_apply_tenant_rls('clip_revisions');
SELECT relay_apply_tenant_rls('render_jobs');
SELECT relay_apply_maintenance_scan('media_analyses');
SELECT relay_apply_maintenance_scan('render_jobs');

GRANT SELECT, INSERT ON media_analyses TO relay_app;
GRANT SELECT ON media_analyses TO relay_worker;
GRANT UPDATE (status, duration_ms, has_audio, coverage, envelope, summary, error_code, error_detail,
              started_at, finished_at, updated_at)
  ON media_analyses TO relay_worker;

GRANT SELECT ON clip_candidates TO relay_app;
GRANT UPDATE (feedback, feedback_by, feedback_at) ON clip_candidates TO relay_app;
GRANT SELECT, INSERT ON clip_candidates TO relay_worker;

GRANT SELECT, INSERT ON clip_projects TO relay_app;
GRANT UPDATE (title, current_revision_id, version, archived_at, updated_at) ON clip_projects TO relay_app;
GRANT SELECT ON clip_projects TO relay_worker;

GRANT SELECT, INSERT ON clip_revisions TO relay_app;
GRANT SELECT ON clip_revisions TO relay_worker;

GRANT SELECT, INSERT ON render_jobs TO relay_app;
GRANT SELECT ON render_jobs TO relay_worker;
GRANT UPDATE (status, renderer_version, output_probe, render_ms, error_code, error_detail,
              started_at, finished_at, updated_at)
  ON render_jobs TO relay_worker;

-- The output asset is created by the app with its reserved maximum size; the worker replaces
-- it with the real size while the row is still validating (the asset guard forbids it later).
GRANT UPDATE (size_bytes) ON media_assets TO relay_worker;
