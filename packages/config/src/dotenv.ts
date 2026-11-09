import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (packages/config/src → ../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Load `<repo>/.env` into process.env for local tooling (worker, scripts, tests).
 * Existing environment variables always win (even empty ones), so deployed processes
 * configured through a secrets manager are unaffected. Production containers do not ship a
 * .env file; RELAY_SKIP_DOTENV=true disables loading entirely (same switch as next.config).
 */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')): void {
  if (process.env.RELAY_SKIP_DOTENV === 'true') return;
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
