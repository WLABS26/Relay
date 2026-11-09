import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Local development reads the single repo-root .env (existing variables always win).
const dotenv = path.join(repoRoot, '.env');
if (existsSync(dotenv) && process.env.RELAY_SKIP_DOTENV !== 'true') process.loadEnvFile(dotenv);

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Container images build with NEXT_OUTPUT=standalone; `next start` (local, E2E) uses the default output.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  outputFileTracingRoot: repoRoot,
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@relay/ui', '@relay/domain', '@relay/config', '@relay/services', '@relay/db', '@relay/media', '@relay/providers'],
  serverExternalPackages: ['pg', 'pino', 'graphile-worker', 'openid-client'],
  devIndicators: false,
  // Do not write generated agent instruction files into the repo (see CLAUDE.md instead).
  agentRules: false,
  // Pages get their headers (CSP with nonce, HSTS, ...) from src/proxy.ts, which skips /api.
  // Every API response, including errors and health probes, gets these.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
