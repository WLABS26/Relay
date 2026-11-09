-- Re-applied after every migration run (idempotent): access to the Graphile Worker schema,
-- which Graphile Worker's own pinned migrations create and may extend on upgrade.
--
-- relay_app has NO access to queue tables: it enqueues only through relay_enqueue_job()
-- (SECURITY DEFINER, migration 0010). relay_worker executes jobs, so it needs the queue
-- tables, functions and — because Graphile Worker enables RLS on its private tables — explicit
-- policies.

REVOKE ALL ON ALL TABLES IN SCHEMA graphile_worker FROM relay_app;
REVOKE ALL ON SCHEMA graphile_worker FROM relay_app;

GRANT USAGE ON SCHEMA graphile_worker TO relay_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO relay_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO relay_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO relay_worker;
GRANT USAGE ON TYPE graphile_worker.job_spec TO relay_worker;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS relay_worker_access ON graphile_worker.%I', t);
    EXECUTE format('CREATE POLICY relay_worker_access ON graphile_worker.%I TO relay_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;
