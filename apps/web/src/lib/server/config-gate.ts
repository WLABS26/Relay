import {
  isConfigError,
  parseConfig,
  resolveDeploymentEnv,
  type DeploymentEnv,
} from '@relay/config';

/**
 * Configuration gate for pages. A long-lived server refuses to start on invalid configuration
 * (instrumentation-node.ts, exit 78). A serverless deployment has no start to refuse, so the
 * proxy answers every page with this gate's result instead of a platform error page.
 */
export type ConfigGate = { ok: true } | { ok: false; env: DeploymentEnv; problems: string[] };

/** The KMS provider is not in this build; mirrors packages/services/src/crypto/envelope.ts. */
const KMS_UNSUPPORTED =
  'RELAY_ENCRYPTION_PROVIDER=kms: the KMS key provider ships with the provider-credential milestone (M3); this build cannot start with it';

export function evaluateConfig(source: Record<string, string | undefined>): ConfigGate {
  try {
    const config = parseConfig(source);
    if (config.encryption.provider === 'kms')
      return { ok: false, env: config.env, problems: [KMS_UNSUPPORTED] };
    return { ok: true };
  } catch (error) {
    if (isConfigError(error))
      return { ok: false, env: resolveDeploymentEnv(source), problems: error.problems };
    throw error;
  }
}

let cached: ConfigGate | undefined;

/** Evaluated once per process; variables only change with a new deployment anyway. */
export function configGate(): ConfigGate {
  cached ??= evaluateConfig(process.env);
  return cached;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/**
 * Self-contained page. Outside production the problems are listed (they name variables and
 * rules, never values); production shows only the generic text and points at the logs, which
 * always carry the list.
 */
export function renderConfigErrorPage(gate: Exclude<ConfigGate, { ok: true }>): string {
  const details =
    gate.env === 'production'
      ? `<p>The full list of problems is in the deployment's server log (Vercel: the project's <em>Logs</em> tab).</p>
<p>If this is a test deployment, the first thing to check is <code>RELAY_ENV</code>: without it Relay applies production rules.</p>`
      : `<p>Fix these variables, then redeploy:</p><ul>${gate.problems
          .map((p) => `<li><code>${escapeHtml(p)}</code></li>`)
          .join('')}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay is not configured yet</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:44rem;padding:2rem 1.25rem}h1{font-size:1.5rem;margin:0 0 .75rem}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#1c2028;padding:.1rem .35rem;border-radius:4px;overflow-wrap:anywhere}
li{margin:.5rem 0}p{margin:.5rem 0}
</style></head><body><main>
<h1>Relay is not configured yet</h1>
<p>This deployment refused to start because its environment variables are incomplete or invalid. Nothing is served until they are fixed.</p>
${details}
</main></body></html>
`;
}
