# syntax=docker/dockerfile:1.7
#
# 9Router · SAIRI edition (Pterodactyl / Pelican ready)
#
# Build from the repository ROOT:
#   docker build -f docker/Dockerfile -t 9router-sairi .
#
# Stage 1 compiles the Next.js app + CLI bundle (needs ~3-4 GB RAM, fine for
# GitHub Actions). Stage 2 is a small runtime image that only contains the
# prebuilt result, so the game panel never has to compile anything.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- builder ---
FROM ${NODE_IMAGE} AS builder
WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096

# Root dependencies first (better layer cache)
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm npm install

COPY . .

# cli/ builds the Next.js standalone app into cli/app (see cli/scripts/build-cli.js)
RUN --mount=type=cache,target=/root/.npm \
    cd cli && npm install && npm run build \
    && rm -rf .build-home \
    && npm prune --omit=dev

# ---------------------------------------------------------------- runtime ---
FROM ${NODE_IMAGE} AS runner

LABEL org.opencontainers.image.title="9router-sairi" \
      org.opencontainers.image.description="9Router with Pterodactyl-friendly numbered menu, banner and auto start" \
      org.opencontainers.image.licenses="MIT" \
      maintainer="sairidev@gmail.com"

ENV DEBIAN_FRONTEND=noninteractive \
    USER=container \
    HOME=/home/container \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NINEROUTER_HOME=/opt/9router \
    NINEROUTER_NO_UPDATE_CHECK=1 \
    TZ=UTC

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates procps iproute2 figlet tzdata jq nano \
    && rm -rf /var/lib/apt/lists/*

# Prebuilt app (cli.js, src, hooks, app/, node_modules)
COPY --from=builder /src/cli/ /opt/9router/

COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/server-headless.sh /usr/local/bin/9router-server

# `9router` = interactive CLI (numbered menu on Pterodactyl), `9router-server` = headless
RUN printf '#!/bin/sh\nexec node /opt/9router/cli.js "$@"\n' > /usr/local/bin/9router \
    && chmod 0755 /usr/local/bin/9router /usr/local/bin/9router-server /entrypoint.sh \
    && useradd -m -d /home/container -s /bin/bash container

USER container
WORKDIR /home/container

# Data (~/.9router: database, settings, runtime) lives in /home/container.
# Mount a volume there (Pterodactyl already does this for every server).
EXPOSE 20128

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
