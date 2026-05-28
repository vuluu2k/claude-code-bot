# Multi-stage build for api / worker / discord-bot services.
# Build once, pick the entrypoint with `command:` in compose.
#
# Runs as the non-root `bun` user (uid 1000, from the base image): Claude Code
# refuses --dangerously-skip-permissions when running as root. An entrypoint
# fixes volume ownership then drops privileges with su-exec.

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
# su-exec              : drop from root → ccb in the entrypoint
RUN apk add --no-cache \
      git openssh-client tmux \
      nodejs npm \
      curl bash jq ripgrep ca-certificates su-exec \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/cache/apk/* /root/.npm

# Reuse the non-root `bun` user (uid/gid 1000) shipped by the base image.
RUN mkdir -p /home/bun/.claude /app/workspaces \
    && chown -R bun:bun /home/bun /app/workspaces

COPY --from=deps /app /app

ENV NODE_ENV=production
ENV CLAUDE_BIN=claude
ENV WORKSPACE_ROOT=/app/workspaces
# Claude CLI reads/writes config + OAuth cache here (the bun home, on a volume).
ENV HOME=/home/bun
ENV CLAUDE_CONFIG_DIR=/home/bun/.claude

COPY infra/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# entrypoint runs as root (to chown volumes) then exec's as ccb.
ENTRYPOINT ["/entrypoint.sh"]
# Default command is the API; worker + bot override via `command:`.
CMD ["bun", "apps/api/src/index.ts"]
