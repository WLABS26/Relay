import { isConfigError, loadConfig } from '@relay/config';
import { assertDeploymentSupported } from '@relay/services';

/**
 * Node-runtime startup checks. Invalid or unsupported configuration stops a long-lived server
 * with EX_CONFIG (78) before it accepts a request, instead of failing on the first request.
 * A serverless platform (Vercel, Lambda, Netlify) has no process to stop: there the problems
 * are logged and every page is answered by the configuration gate in src/proxy.ts, every API
 * route with 503, until the variables are fixed.
 */
const serverless = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
);

try {
  const config = loadConfig();
  assertDeploymentSupported(config);
  console.log(
    `[relay-web] env=${config.env} demoMode=${config.demoMode} publicUrl=${config.publicOrigin}`,
  );
} catch (error) {
  if (isConfigError(error)) {
    console.error(error.message);
    if (serverless) {
      console.error(
        '[relay-web] serving the configuration error page until the variables above are fixed',
      );
    } else {
      process.exit(78);
    }
  } else {
    throw error;
  }
}
