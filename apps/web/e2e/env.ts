import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_PORT = 3100;
export const E2E_WORKER_HEALTH_PORT = 3102;
export const E2E_DATABASE = 'relay_e2e';
export const E2E_BUCKET = 'relay-e2e';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.join(REPO_ROOT, 'fixtures/media');
