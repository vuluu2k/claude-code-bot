# Local development

## Prereqs

* **Bun ≥ 1.1**, **Node ≥ 20**, **Docker**, **git**, **gh**, **tmux** (optional but recommended).
* **Claude Code CLI**: `npm i -g @anthropic-ai/claude-code` and `claude login`.

## One-shot setup

```bash
./infra/scripts/bootstrap.sh
```

This installs deps, brings up Postgres+Redis in Docker, runs migrations, and
seeds `.env`.

## Run the stack

Three terminals:

```bash
# Terminal 1
bun run start:api

# Terminal 2
bun run start:worker

# Terminal 3 — one-time slash-command sync, then run the bot
bun run bot:register
bun run start:bot
```

Or use turbo to run dev mode for everything:

```bash
bun run dev
```

## Useful commands

```bash
bun run typecheck                  # turbo runs tsc --noEmit across all packages
bun run db:generate                # drizzle-kit generate from schema.ts
bun run db:studio                  # web UI for the database
bun run bot:register   # re-sync slash commands

# Manually register a repo via HTTP
curl -X POST http://localhost:4000/repos \
  -H 'content-type: application/json' \
  -d '{"slug":"myapp","remoteUrl":"https://github.com/me/myapp.git"}'

# Queue a task via HTTP
curl -X POST http://localhost:4000/tasks \
  -H 'content-type: application/json' \
  -d '{"repoSlug":"myapp","prompt":"summarize the architecture"}'

# Stream events
curl -N http://localhost:4000/tasks/<task-id>/stream
```

## Testing without the Claude CLI

For local development without burning API calls, set `CLAUDE_BIN=bash` and use
prompts like `-c 'echo hello'`. The runner's argv structure still passes the
prompt as the final positional arg, so bash treats it as a (silent) script
argument; you'll see the spawn/stream pipeline end-to-end without actually
invoking Claude.

## Project conventions

* **No barrel re-exports** for cross-package boundaries — import from the
  explicit subpath (`@ccb/shared/config`) so tree-shaking works and bundle
  graphs stay legible.
* **Argv arrays only** for shell — never assemble command strings.
* **Slugs are user-visible identifiers** — keep them lowercase-kebab.
* **Pino for logs** — no `console.log` in production code paths.
* **No backwards-compat shims** — this is a young codebase; rename freely
  and migrate callers in the same PR.
