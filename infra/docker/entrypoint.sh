#!/bin/sh
# Runs as root: fix ownership of mounted volumes (named volumes mount root-owned
# on first creation), then drop to the non-root `bun` user (uid 1000, shipped by
# the oven/bun base image). Claude Code refuses --dangerously-skip-permissions
# as root, so the app must not run as root.
set -e

mkdir -p /app/workspaces /home/bun/.claude

# Deep chown only when ownership is wrong (first boot / pre-existing root-owned
# volume). Once correct, subsequent boots skip the expensive recursive pass.
if [ "$(stat -c %u /app/workspaces 2>/dev/null)" != "1000" ]; then
  echo "entrypoint: chowning /app/workspaces to bun"
  chown -R bun:bun /app/workspaces || true
fi
if [ "$(stat -c %u /home/bun/.claude 2>/dev/null)" != "1000" ]; then
  chown -R bun:bun /home/bun/.claude || true
fi

# Authenticate git for github.com so Claude's own `git push` / `gh pr create`
# work (clone, push branches, open PRs). The token is rewritten into github
# URLs via insteadOf, written to the bun user's gitconfig — ephemeral, rebuilt
# from env each boot, never persisted to a volume.
if [ -n "$GITHUB_TOKEN" ]; then
  su-exec bun git config --global \
    "url.https://x-access-token:${GITHUB_TOKEN}@github.com/.insteadOf" \
    "https://github.com/" || true
  su-exec bun git config --global credential."https://github.com".helper "" || true
fi

# Sensible default git identity for AI-authored commits (override per repo).
su-exec bun git config --global user.name "${GIT_AUTHOR_NAME:-claude-code-bot}" || true
su-exec bun git config --global user.email "${GIT_AUTHOR_EMAIL:-bot@claude-code-bot.local}" || true
su-exec bun git config --global init.defaultBranch main || true

exec su-exec bun "$@"
