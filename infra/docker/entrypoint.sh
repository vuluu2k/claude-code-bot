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

exec su-exec bun "$@"
