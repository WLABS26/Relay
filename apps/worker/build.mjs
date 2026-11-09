// Bundle the worker for production. Workspace packages (TypeScript source) are bundled;
// runtime dependencies with native or dynamic loading stay external and ship in node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'linked',
  external: ['pg', 'pg-native', 'graphile-worker', 'pino', '@aws-sdk/*', 'openid-client'],
  banner: {
    js: "import { createRequire as __relayCreateRequire } from 'node:module'; const require = __relayCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
