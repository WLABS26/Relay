/**
 * Minimum Relay schema version this build requires. Processes refuse to start against an older
 * database. A unit test keeps it equal to the newest migration file.
 */
export const REQUIRED_SCHEMA_VERSION = '0012';

/** Graphile Worker schema revision shipped by graphile-worker@0.18.0 (sql/000020.sql). */
export const GRAPHILE_WORKER_SCHEMA_REVISION = 20;
