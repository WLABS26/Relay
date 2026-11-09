import { loadConfig } from '@relay/config';
import { createServiceContext, type ServiceContext } from '@relay/services';

/**
 * One ServiceContext (app role pool, storage client, logger) per server process. Cached on
 * globalThis so development hot reloads do not leak database pools.
 */
const globalForRelay = globalThis as unknown as { __relayWebContext?: ServiceContext };

export function webContext(): ServiceContext {
  if (!globalForRelay.__relayWebContext) {
    globalForRelay.__relayWebContext = createServiceContext({ config: loadConfig(), role: 'app' });
  }
  return globalForRelay.__relayWebContext;
}
