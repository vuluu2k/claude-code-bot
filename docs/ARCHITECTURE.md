# Architecture

## Goal

Run AI software-engineering tasks against arbitrary repositories from
Discord (or any HTTP client), safely and concurrently, with full audit logs
and zero risk of corrupting the operator's working tree.

## Data flow (happy path)

```
Discord user                         Hono API                  BullMQ           Worker (per task)
─────────────                        ─────────                 ──────           ─────────────────
/repo myapp fix the login bug  ────► POST /tasks ────► enqueue {task,prompt}    pick job
                                       │                                         ├─ ensureFresh(repoSlug)
                                       │  201 + taskId                           ├─ worktrees.create(...)
                               ◄───────┤                                         ├─ prompts.build(...)
                                                                                 ├─ runClaudeTask(...) ── stream
SSE subscribe                                                                    │      │
/tasks/:id/stream  ◄──── Redis pub/sub  ◄──────────────────────────  publish ────┤      │
                                                                                 ├─ summarizeDiff()
                                                                                 └─ updateStatus(succeeded)
```

Each `taskId` has a dedicated Redis pub/sub channel:

* `ccb.events.<taskId>`        — stdout / stderr / status / diff events
* `ccb.events.<taskId>.cancel` — fan-in cancel signal (API → all workers)

The API SSE endpoint subscribes; the Discord bot subscribes directly to
Redis for cheap fan-out.

## Isolation model

| Layer | Guarantee |
|------|-----------|
| **Repository registry** | One canonical clone under `workspaces/repos/<slug>`. Slugs are validated against `/^[a-z0-9][a-z0-9-_]*$/` before they touch the filesystem. |
| **Worktree** | Every task gets its own ephemeral branch + worktree under `workspaces/worktrees/<slug>/<task-id>`. The main clone is never modified by Claude. |
| **Sandbox policy** | `host` mode runs commands directly with `cwd` pinned to the worktree. `docker` mode wraps the command inside a non-root container with CPU/mem caps, mounted only at `/workspace`. |
| **Shell wrapper** | `@ccb/shared/shell` *always* uses an argv array and `shell: false` — no interpolation, no command injection. |
| **Destructive-command refusal** | `assertCommandAllowed` rejects `rm -rf /`, fork bombs, mkfs, shutdown etc. before they reach the sandbox. |

## Persistence

* **Postgres** (Drizzle): `repos`, `sessions`, `tasks`, `task_logs`.
* **Filesystem**:
  * `workspaces/repos/<slug>/`               — canonical clone
  * `workspaces/worktrees/<slug>/<task-id>/` — per-task isolated checkout
  * `workspaces/memory/<slug>/`              — long-lived per-repo memory

## Extension points

* **Multiple workers / VPS**: just run more `apps/worker` processes pointing
  at the same Redis. BullMQ handles distribution. Workspaces should be on a
  shared volume if you want any worker to serve any repo (or shard repos to
  workers).
* **Multiple AI providers**: `@ccb/claude-runner` is a thin wrapper around
  the Claude CLI. Swap it (or add a sibling) to drive a different provider.
* **PR auto-review**: the worker already captures full diffs — wire
  `github-tools.createPullRequest` after `succeeded` to auto-open PRs.
* **CI/CD**: an `apps/scheduler` running BullMQ schedulers can trigger tasks
  from webhooks (`apps/api` already has an HTTP surface to accept them).

## Configuration

All env vars are loaded once via `@ccb/shared/config` (zod-validated). See
[`.env.example`](../.env.example) for the full list.
