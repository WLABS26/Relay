# Dev container image: Ubuntu 24.04 (FFmpeg 6.1, the version Relay's media validation is
# verified against) plus Node 22 and pnpm. Node comes from the same digest-pinned official
# image as the production Dockerfiles, so the dev container, CI and the images agree.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS node

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# Optional: behind a TLS-intercepting (corporate) proxy, place its CA certificate at
# .devcontainer/extra-ca.crt (git-ignored). It is trusted by apt, curl, Node and pnpm.
# Codespaces and ordinary networks need nothing here.
COPY . /tmp/devcontainer-context/
RUN if [ -f /tmp/devcontainer-context/extra-ca.crt ]; then \
      install -m 0644 /tmp/devcontainer-context/extra-ca.crt /usr/local/share/ca-certificates/relay-extra-ca.crt \
   && update-ca-certificates \
   && cp /usr/local/share/ca-certificates/relay-extra-ca.crt /etc/relay-extra-ca.crt \
   && echo 'export NODE_EXTRA_CA_CERTS=/etc/relay-extra-ca.crt' > /etc/profile.d/relay-extra-ca.sh; \
    fi \
 && rm -rf /tmp/devcontainer-context

RUN apt-get -o Acquire::Retries=5 update \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      ffmpeg postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# Node 22 (binary, npm and corepack) and pnpm 10.28.0, available to every user.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && if [ -f /etc/relay-extra-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/relay-extra-ca.crt; fi \
 && npm install -g pnpm@10.28.0 \
 && node --version && pnpm --version && ffmpeg -version | head -1

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
