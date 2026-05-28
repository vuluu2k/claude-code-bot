# claude-code-bot

Self-hosted **AI Engineering Platform** that lets you drive Claude Code from
Discord, run tasks against any registered repository inside isolated git
worktrees, stream output back, and inspect diffs — all from a single VPS.

```
Discord  ─►  API (Hono)  ─►  Redis (BullMQ)  ─►  Worker  ─►  git worktree  ─►  Claude Code CLI
                  │                                                    │
                  └──────────── SSE / Pub-Sub ────────────────────────┘
```

## Highlights

* **Bun + TypeScript + Turborepo** monorepo, no NestJS, no Prisma.
* **Hono** API with SSE streaming and zod-validated routes.
* **BullMQ** task queue with cancellation, per-task abort signals, and graceful shutdown.
* **discord.js v14** bot with slash commands and live streaming embeds.
* **Drizzle ORM** schema with Postgres — typed end-to-end.
* **Git worktree isolation** — every task runs in its own branch under
  `workspaces/worktrees/<repo>/<task-id>`. The main clone is never touched.
* **Memory system** — markdown + JSON per repository, automatically injected
  into prompts.
* **Sandbox boundary** — host or Docker mode with CPU/mem caps,
  destructive-command refusal, mount isolation.
* **Tmux integration** for persistent reattachable sessions.
* **Minimal React dashboard** with live SSE log tailing.

## Repository layout

```
apps/
  api/          Hono API server                 — apps/api/src
  worker/       BullMQ worker that runs Claude  — apps/worker/src
  discord-bot/  discord.js slash commands       — apps/discord-bot/src
  dashboard/    Vite + React UI                 — apps/dashboard/src
packages/
  shared/         config, logger, errors, ids, shell wrapper, common types
  db/             Drizzle schema + client + migrate script
  repo-manager/   git, worktree, registry, diff summarization
  memory-system/  per-repo markdown/json memory
  prompt-system/  composes system + memory + CLAUDE.md + task into one prompt
  claude-runner/  spawns Claude CLI, streams output, tmux helpers
  sandbox/        host/docker policy + destructive-command refusal
  github-tools/   gh CLI wrappers (PRs, issues, commits)
infra/
  docker/    docker-compose for Postgres+Redis, Dockerfiles for app+sandbox
  scripts/   bootstrap.sh and operational scripts
workspaces/  cloned repos and per-task worktrees (gitignored)
docs/        architecture, deploy, security
```

## Quick start (local)

```bash
# 1. One-shot setup
./infra/scripts/bootstrap.sh

# 2. Fill in .env (DISCORD_TOKEN, DISCORD_CLIENT_ID, GITHUB_TOKEN, …)

# 3. In three terminals
bun run start:api
bun run start:worker
bun run bot:register   # optional — the bot also auto-registers on boot
bun run start:bot
```

Then in Discord:

```
/register-repo slug:myapp url:https://github.com/me/myapp.git
/repo repo:myapp task:fix the broken login redirect
```

## Deploy

* **Coolify (recommended for self-hosters)** — see [docs/COOLIFY.md](docs/COOLIFY.md). One-click deploy from a Git repo, env vars in the UI, auto Let's Encrypt.
* **Plain VPS / docker compose** — see [docs/DEPLOY.md](docs/DEPLOY.md).

See [docs/](docs/) for full architecture, security, and deployment details.

## License

MIT
