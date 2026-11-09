import { isConfigError, loadConfig } from '@relay/config';
import { assertDeploymentSupported } from '@relay/services';

/**
 * Node-runtime startup checks. Invalid or unsupported configuration stops the server with
 * EX_CONFIG (78) before it accepts a request, instead of failing on the first request.
 */
try {
  const config = loadConfig();
  assertDeploymentSupported(config);
  console.log(`[relay-web] env=${config.env} demoMode=${config.demoMode} publicUrl=${config.publicOrigin}`);
} catch (error) {
  if (isConfigError(error)) {
    console.error(error.message);
    process.exit(78);
  }
  throw error;
}
