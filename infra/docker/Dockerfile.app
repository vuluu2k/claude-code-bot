# Multi-stage build for api / worker / discord-bot services.
# Build once, pick the entrypoint with `command:` in compose.
#
# Includes the Claude Code CLI so workers running SANDBOX_MODE=host can spawn
# `claude --print ...` directly inside the container. The CLI authenticates
# via ANTHROPIC_API_KEY env var — see docs/COOLIFY.md.

FROM oven/bun:1.1-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
COPY tsconfig.base.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.1-alpine AS runtime
WORKDIR /app

# git / openssh-client : clone repos
# tmux                 : persistent sessions
# nodejs + npm         : install + run @anthropic-ai/claude-code
# curl / bash / jq     : misc tooling Claude often shells out to
# ripgrep              : Claude's preferred search tool
RUN apk add --no-cache \
      git openssh-client tmux \
      nodejs npm \
      curl bash jq ripgrep ca-certificates \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/cache/apk/* /root/.npm

COPY --from=deps /app /app

ENV NODE_ENV=production
ENV CLAUDE_BIN=claude
ENV WORKSPACE_ROOT=/app/workspaces
# Claude CLI reads/writes OAuth tokens here. Mount a persistent volume at
# this path so login survives redeploys (see docker-compose.coolify.yml).
ENV HOME=/root
ENV CLAUDE_CONFIG_DIR=/root/.claude

# Default entrypoint is the API; worker + bot override via `command:`.
CMD ["bun", "apps/api/src/index.ts"]
