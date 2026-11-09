# Relay web image: the Next.js app as a standalone Node server. Runs as the unprivileged
# `node` user. All configuration is read at runtime from the environment; nothing secret is
# baked in at build time.
#
#   docker build -f infra/docker/web.Dockerfile -t relay-web .
#   docker run --rm -p 3000:3000 --env-file prod.env relay-web
#
# Behind a TLS-intercepting proxy, pass its CA bundle as a build secret (never stored in a
# layer):  docker build --secret id=extra_ca,src=/path/to/ca.pem ...
#
# The base image is pinned by digest (Node 22.23.4, Debian bookworm). Bump deliberately.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# ---- build ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=relay-pnpm-store,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable && corepack install \
 && pnpm config set store-dir /pnpm/store \
 && pnpm fetch
COPY . .
# The build never needs real credentials: RELAY_SKIP_DOTENV keeps any stray .env out, and
# configuration is validated when the server starts (exit 78 on invalid production config).
RUN --mount=type=cache,id=relay-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --offline \
 && RELAY_SKIP_DOTENV=true NEXT_OUTPUT=standalone pnpm --filter @relay/web run build

# ---- runtime ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# No extra OS packages: the Next.js server handles SIGTERM itself and spawns no children.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Standalone output keeps the monorepo layout (outputFileTracingRoot is the repo root).
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# Next.js may write its cache here; everything else stays read-only for the runtime user.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
