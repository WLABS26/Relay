-- 0010 Transactional enqueue without direct queue-table access.
--
-- Graphile Worker enables row-level security on its private tables and expects to run as
-- their owner. Instead of granting the web role read/write access to every queued job, the
-- web and worker roles enqueue through this SECURITY DEFINER wrapper, which runs on the
-- caller's connection and transaction (so the job commits or rolls back with the business
-- write) but with the schema owner's rights. The search_path is pinned to prevent hijacking,
-- and task identifiers are validated. plpgsql bodies resolve objects at call time, so this is
-- created before Graphile Worker's own migrations run.

CREATE FUNCTION relay_enqueue_job(
  identifier   text,
  payload      json,
  queue_name   text,
  run_at       timestamptz,
  max_attempts integer,
  job_key      text,
  priority     integer,
  job_key_mode text
) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_id bigint;
BEGIN
  IF identifier IS NULL OR identifier !~ '^[a-z][a-z0-9_.]{2,79}$' THEN
    RAISE EXCEPTION 'invalid task identifier %', identifier USING ERRCODE = '22023';
  END IF;
  IF job_key IS NOT NULL AND length(job_key) > 300 THEN
    RAISE EXCEPTION 'job key too long' USING ERRCODE = '22023';
  END IF;
  IF payload IS NOT NULL AND pg_catalog.octet_length(payload::text) > 8192 THEN
    RAISE EXCEPTION 'job payload too large (payloads must be ID/version pointers)' USING ERRCODE = '22023';
  END IF;
  SELECT (graphile_worker.add_job(
            identifier, payload, queue_name, run_at, max_attempts, job_key, priority, NULL,
            COALESCE(job_key_mode, 'replace'))).id
    INTO v_id;
  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION relay_enqueue_job(text, json, text, timestamptz, integer, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_enqueue_job(text, json, text, timestamptz, integer, text, integer, text)
  TO relay_app, relay_worker;
