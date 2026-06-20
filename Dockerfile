# FOREMAN — Core daemon + dashboard.
#
# Note on the Coder: FOREMAN drives the `claude` CLI, installed here. In a container the
# practical auth path is an API key (set coder.auth: api_key and pass ANTHROPIC_API_KEY).
# For subscription/OAuth, running the daemon on the host is simpler (see README).

# ── build: install deps + build the dashboard ───────────────────────────────
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm --filter betteryes build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
# BYO Claude Code (pin a version to taste).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=build /app /app

ENV FOREMAN_HOME=/data \
    FOREMAN_BIND=0.0.0.0 \
    FOREMAN_PORT=7777 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 7777

# Config + secrets come from mounted foreman.yaml/rules.yaml and the environment (.env).
CMD ["pnpm", "--filter", "@foreman/core", "exec", "tsx", "bin/foreman.ts", "serve"]
