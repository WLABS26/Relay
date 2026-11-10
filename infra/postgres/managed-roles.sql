-- Relay roles for a MANAGED PostgreSQL (Neon, RDS, Cloud SQL, Supabase, ...). Run once as the
-- database's administrative role, for example in the provider's SQL editor. This is the
-- managed-database equivalent of infra/postgres/init/00-relay-roles.sh (which the local
-- Compose stack runs automatically).
--
-- Replace the three placeholders with long, unique, randomly generated passwords, and keep
-- them in your secrets manager. Afterwards:
--   relay_migrator  → DATABASE_URL_MIGRATOR (direct, non-pooled host) — migrations only
--   relay_app       → DATABASE_URL_APP      (pooled host is fine)     — web app
--   relay_worker    → DATABASE_URL_WORKER   (direct, non-pooled host) — worker (LISTEN/NOTIFY)
-- None of the roles is a superuser or bypasses row-level security.

CREATE ROLE relay_migrator LOGIN PASSWORD '<MIGRATOR_PASSWORD>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_app      LOGIN PASSWORD '<APP_PASSWORD>'      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_worker   LOGIN PASSWORD '<WORKER_PASSWORD>'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Statement timeouts keep a misbehaving request from holding locks indefinitely.
ALTER ROLE relay_app    SET statement_timeout = '15s';
ALTER ROLE relay_app    SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE relay_worker SET statement_timeout = '60s';
ALTER ROLE relay_worker SET idle_in_transaction_session_timeout = '60s';

-- The application database, owned by the migrator so migrations can create and alter objects.
-- If your provider created the database for you, run instead:
--   ALTER DATABASE <name> OWNER TO relay_migrator;
CREATE DATABASE relay OWNER relay_migrator;
REVOKE ALL ON DATABASE relay FROM PUBLIC;
GRANT CONNECT ON DATABASE relay TO relay_app, relay_worker;
