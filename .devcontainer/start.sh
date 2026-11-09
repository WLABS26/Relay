#!/usr/bin/env bash
# Starts the web app and the worker in the background (logs in /tmp/relay-web.log and
# /tmp/relay-worker.log). Runs on every container start; safe to re-run.
#
# In GitHub Codespaces the browser reaches the app through forwarded ports with https URLs
# that differ from localhost, so the public URLs are derived from the codespace name here and
# passed as environment variables (which take precedence over .env). .env itself stays on
# localhost so `pnpm test:integration` and `pnpm test:e2e` keep working inside the codespace.
set -euo pipefail
cd "$(dirname "$0")/.."
# Corporate-proxy CA installed by the Dockerfile, if any (see .devcontainer/Dockerfile).
if [ -f /etc/relay-extra-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/relay-extra-ca.crt; fi

if [ -f .env ] && [ -d node_modules ]; then :; else
  echo "[relay] not set up yet; run: bash .devcontainer/post-create.sh"
  exit 0
fi

if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  export RELAY_PUBLIC_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  export S3_PUBLIC_ENDPOINT="https://${CODESPACE_NAME}-7070.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  # Browser uploads and previews go straight to object storage: allow this origin in CORS
  # (keeping localhost, which the automated suites and in-container browsers use).
  S3_CORS_ORIGINS="${RELAY_PUBLIC_URL} http://localhost:3000 http://127.0.0.1:3000" pnpm storage:provision >/dev/null
  echo "[relay] Codespaces: web at ${RELAY_PUBLIC_URL}"
  echo "[relay] Codespaces: make port 7070 Public (Ports panel) so your browser can load media."
fi

pkill -f 'tsx watch --clear-screen=false src/main.ts' 2>/dev/null || true
pkill -f 'next dev --port 3000' 2>/dev/null || true
sleep 1
nohup pnpm worker:dev > /tmp/relay-worker.log 2>&1 &
nohup pnpm dev > /tmp/relay-web.log 2>&1 &

for _ in $(seq 1 90); do
  curl -fsS http://localhost:3000/api/ready >/dev/null 2>&1 && break
  sleep 1
done
echo "[relay] web:    $(curl -fsS http://localhost:3000/api/ready 2>/dev/null || echo 'not ready yet; see /tmp/relay-web.log')"
echo "[relay] worker: $(curl -fsS http://127.0.0.1:3101/readyz 2>/dev/null || echo 'not ready yet; see /tmp/relay-worker.log')"
