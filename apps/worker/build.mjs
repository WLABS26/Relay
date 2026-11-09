// Bundle the worker (and the migration runner) for production. Workspace packages (TypeScript
// source) are bundled; runtime dependencies with native or dynamic loading stay external and
// are declared as direct dependencies of @relay/worker, so `pnpm deploy` places them where the
// bundle can resolve them.
//
// dist/migrate.js resolves its SQL from `../migrations` (relative to dist/), so the image ships
// packages/db/migrations at /app/migrations.
import { build } from 'esbuild';

await build({
  entryPoints: {
    main: 'src/main.ts',
    migrate: '../../packages/db/src/cli/migrate.ts',
  },
  outdir: 'dist',
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
