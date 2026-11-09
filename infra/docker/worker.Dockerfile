# Relay worker image: Graphile Worker task pools (general, media) with FFmpeg, plus the
# migration runner as a separate one-off command. Runs as the unprivileged `relay` user.
#
#   docker build -f infra/docker/worker.Dockerfile -t relay-worker .
#   docker run --rm --env-file prod.env relay-worker                       # worker
#   docker run --rm --env-file prod.env relay-worker node dist/migrate.js  # migrations (operator action)
#
# Behind a TLS-intercepting proxy, pass its CA bundle as a build secret (never stored in a
# layer):  docker build --secret id=extra_ca,src=/path/to/ca.pem ...
#
# Base images are pinned by digest. Bump deliberately:
#   NODE_IMAGE     Node 22.23.4 (build tooling, and the node binary copied into the runtime)
#   RUNTIME_IMAGE  Ubuntu 24.04 LTS, whose FFmpeg 6.1 is the version Relay's hostile-media
#                  validation suite is verified against
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ARG RUNTIME_IMAGE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

FROM ${NODE_IMAGE} AS node

# ---- build: install, bundle, and produce a pruned production deployment -------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=relay-pnpm-store,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && corepack enable && corepack install \
 && pnpm config set store-dir /pnpm/store \
 && pnpm fetch
COPY . .
RUN --mount=type=cache,id=relay-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --offline \
 && pnpm --filter @relay/worker run build
# Re-install only the worker's production dependencies, from the same lockfile (reproducible,
# offline). Workspace packages are inside the bundle, so their links are dropped.
RUN --mount=type=cache,id=relay-pnpm-store,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm --filter "@relay/worker..." install --prod --frozen-lockfile --offline \
 && rm -rf apps/worker/node_modules/@relay \
 && mkdir -p /out/apps/worker \
 && cp -a node_modules /out/node_modules \
 && cp -a apps/worker/node_modules apps/worker/dist apps/worker/package.json /out/apps/worker/ \
 && cp -a packages/db/migrations /out/apps/worker/migrations

# ---- runtime ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
# ffmpeg/ffprobe for media validation (run sandboxed by the worker); tini reaps any orphaned
# child processes and forwards signals so in-flight jobs drain on SIGTERM.
RUN apt-get -o Acquire::Retries=5 update \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 relay \
 && useradd --system --uid 10001 --gid relay --no-create-home --shell /usr/sbin/nologin relay
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
COPY --from=build /out /app
# dist/migrate.js reads its SQL from ../migrations, i.e. /app/apps/worker/migrations.
WORKDIR /app/apps/worker
USER relay
# Liveness only: readiness (/readyz) additionally requires the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.RELAY_WORKER_HEALTH_PORT || 3101) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
