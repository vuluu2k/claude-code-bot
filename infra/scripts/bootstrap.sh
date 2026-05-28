#!/usr/bin/env bash
# Local dev bootstrap. Idempotent.
#
# Usage: ./infra/scripts/bootstrap.sh
#
# Steps:
#   1. Verify required CLIs (bun, git, docker, gh, claude).
#   2. Install workspace deps.
#   3. Bring up Postgres + Redis via docker compose.
#   4. Generate + apply database migrations.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

color() { printf "\033[1;%sm%s\033[0m\n" "$1" "$2"; }
ok()    { color 32 "✓ $1"; }
warn()  { color 33 "! $1"; }
fail()  { color 31 "✗ $1"; exit 1; }

# 1. Preflight
for bin in bun git docker; do
  command -v "$bin" >/dev/null 2>&1 || fail "$bin is required (not on PATH)"
done
ok "bun, git, docker installed"

command -v claude >/dev/null 2>&1 || warn "claude CLI not on PATH — workers will fail to run tasks"
command -v gh >/dev/null 2>&1 || warn "gh CLI not on PATH — PR commands will fail"
command -v tmux >/dev/null 2>&1 || warn "tmux not installed — persistent sessions disabled"

# 2. Env
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "Created .env from template — fill in DISCORD_TOKEN, GITHUB_TOKEN, etc."
else
  ok ".env exists"
fi

# 3. Install deps
ok "Installing workspace dependencies"
bun install

# 4. Infra
ok "Starting Postgres + Redis via docker compose"
docker compose -f infra/docker/docker-compose.yml up -d

# Wait for Postgres
for i in {1..30}; do
  if docker compose -f infra/docker/docker-compose.yml exec -T postgres pg_isready -U ccb -d ccb >/dev/null 2>&1; then
    ok "Postgres ready"
    break
  fi
  sleep 1
done

# 5. Migrations
ok "Generating and applying Drizzle migrations"
bun run db:generate || true
bun run db:migrate

ok "Bootstrap complete."
echo
echo "Next steps:"
echo "  1. Fill in .env (Discord, GitHub, Anthropic tokens)"
echo "  2. Start the API:    bun run start:api"
echo "  3. Start the worker: bun run start:worker"
echo "  4. (optional) Pre-register slash commands: bun run bot:register  — the bot also auto-registers on boot"
echo "  5. Start the bot:    bun run start:bot"
