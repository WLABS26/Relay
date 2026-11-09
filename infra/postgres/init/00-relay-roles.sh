#!/bin/sh
# Runs once, on first initialisation of the local Postgres volume.
#
# Creates three least-privilege roles (see docs/security-model.md):
#   relay_migrator  owns the schema and runs migrations (CREATEDB so tests can create
#                   throwaway databases). Not a superuser, no BYPASSRLS.
#   relay_app       web application role. Not an owner, no BYPASSRLS.
#   relay_worker    background job role. Not an owner, no BYPASSRLS.
# Passwords are passed as psql variables (quoted with :'var'), never interpolated as SQL.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_pw="$RELAY_MIGRATOR_PASSWORD" \
  -v app_pw="$RELAY_APP_PASSWORD" \
  -v worker_pw="$RELAY_WORKER_PASSWORD" <<'EOSQL'
CREATE ROLE relay_migrator LOGIN PASSWORD :'migrator_pw' CREATEDB NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_app      LOGIN PASSWORD :'app_pw'      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_worker   LOGIN PASSWORD :'worker_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Statement timeouts keep a misbehaving request from holding locks indefinitely.
ALTER ROLE relay_app    SET statement_timeout = '15s';
ALTER ROLE relay_app    SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE relay_worker SET statement_timeout = '60s';
ALTER ROLE relay_worker SET idle_in_transaction_session_timeout = '60s';

CREATE DATABASE relay OWNER relay_migrator;
REVOKE ALL ON DATABASE relay FROM PUBLIC;
GRANT CONNECT ON DATABASE relay TO relay_app, relay_worker;
EOSQL
