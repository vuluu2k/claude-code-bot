# VPS deployment

These notes target a single Ubuntu 22.04+ VPS (≥ 2 vCPU / 4 GB RAM).

## 1. Prereqs

```bash
# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Bun (for ad-hoc commands; the containers ship their own bun)
curl -fsSL https://bun.sh/install | bash

# Claude Code CLI (needed if you run worker outside Docker)
npm install -g @anthropic-ai/claude-code

# gh + tmux (optional but recommended)
sudo apt install -y gh tmux git
```

## 2. Clone & configure

```bash
git clone <your-fork> claude-code-bot
cd claude-code-bot
cp .env.example .env
$EDITOR .env          # fill in tokens, ports, etc.
```

## 3. Bring up the stack

```bash
docker compose -f infra/docker/docker-compose.full.yml --env-file .env up -d --build
docker compose -f infra/docker/docker-compose.full.yml exec api bun --filter @ccb/db migrate
docker compose -f infra/docker/docker-compose.full.yml exec bot bun --filter @ccb/discord-bot register
```

This launches: postgres, redis, api (port 4000), worker, discord-bot.

## 4. Reverse proxy (optional)

If you want the dashboard exposed publicly, run it behind Caddy:

```caddy
ccb.example.com {
  reverse_proxy /api/* localhost:4000
  reverse_proxy localhost:5173
}
```

Front the **API** with auth (basic auth, Cloudflare Access, mTLS — pick one).
Discord-only deployments can keep API on `localhost`.

## 5. Persistence

* Postgres data: `ccb-pgdata` named volume.
* Redis data: `ccb-redis` named volume.
* Workspaces (clones + worktrees): `ccb-workspaces` volume — back this up if
  long-running sessions matter.

## 6. Upgrades

```bash
git pull
docker compose -f infra/docker/docker-compose.full.yml up -d --build
docker compose -f infra/docker/docker-compose.full.yml exec api bun --filter @ccb/db migrate
```

## 7. Scaling out

* Add more `worker` replicas with `docker compose ... up -d --scale worker=4`.
  BullMQ distributes jobs automatically.
* When you need workers on different hosts, move `workspaces/` to a shared
  volume (NFS, EFS, or a separate per-worker workspace and shard by repo
  slug at enqueue time).
* The API is stateless except for the Redis/PG dependencies — scale it
  horizontally behind any L7 load balancer.

## 8. Observability

Logs are pino-JSON. Pipe through `pino-pretty` locally or ship to Loki /
Datadog via a sidecar. Each log line carries `component` and `taskId` for
trivial filtering.
