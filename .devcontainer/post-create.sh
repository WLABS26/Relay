#!/usr/bin/env bash
# Runs once when the dev container is created: the README quick start, unattended.
# PostgreSQL and object storage run as sibling containers sharing this container's network
# namespace (see compose.yaml), so they are reachable on 127.0.0.1 exactly as in .env.example.
set -euo pipefail
cd "$(dirname "$0")/.."
# Corporate-proxy CA installed by the Dockerfile, if any (see .devcontainer/Dockerfile).
if [ -f /etc/relay-extra-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/relay-extra-ca.crt; fi

echo "[relay] waiting for PostgreSQL and object storage…"
for _ in $(seq 1 120); do
  if pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1 \
     && curl -fsS http://127.0.0.1:7070/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432 -U postgres
curl -fsS http://127.0.0.1:7070/health >/dev/null

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[relay] created .env from .env.example (development placeholders only)"
fi

pnpm install --frozen-lockfile
pnpm db:migrate
pnpm fixtures:generate
pnpm db:seed
# Browser for the end-to-end suite (installs its system libraries, hence sudo). Only the E2E
# suite needs it, so a blocked download must not leave the container unusable.
if ! pnpm --filter @relay/web exec playwright install --with-deps chromium; then
  echo "[relay] Playwright browser not installed (download blocked?). The app works; for pnpm test:e2e run:"
  echo "[relay]   pnpm --filter @relay/web exec playwright install --with-deps chromium"
fi

echo
echo "[relay] ready. Start the app with: bash .devcontainer/start.sh   (also runs on every container start)"
