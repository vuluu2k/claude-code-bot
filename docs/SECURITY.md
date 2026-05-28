# Security model

This file documents the **threat model** and the controls that defend against
each class of risk. Read it before changing anything in `@ccb/sandbox`,
`@ccb/shared/shell`, or the registry slug validation.

## Threats considered

1. **Malicious Discord input** — a user passes shell metacharacters, path
   traversal, or destructive commands in their task prompt.
2. **Misbehaving Claude run** — a model decides to `rm -rf /`, write outside
   the worktree, or exfiltrate secrets.
3. **Token leakage** — Discord/GitHub/Anthropic tokens accidentally written
   to logs, persisted to the database, or sent back to the user.
4. **Resource exhaustion** — runaway Claude run, log flood, or stuck process
   consumes all CPU/RAM/disk.
5. **Repository contamination** — task A modifies repository state that
   leaks into task B.

## Controls

### Input sanitization

* Repo slugs: regex `^[a-z0-9][a-z0-9-_]*$` enforced before any filesystem
  call (`@ccb/repo-manager/registry`).
* Base branches: regex `^[a-zA-Z0-9._\/\-]+$` (`@ccb/repo-manager/worktree`).
* Shell args: `@ccb/shared/shell` forces `shell: false` and requires argv
  arrays. There is no codepath that accepts a single string command.
* `@ccb/sandbox/assertCommandAllowed` refuses obviously destructive command
  lines (`rm -rf /`, `mkfs`, fork bombs, etc.).

### Headless tool permissions

The worker runs Claude with `--dangerously-skip-permissions` (toggle with
`CLAUDE_SKIP_PERMISSIONS=false`). This is **required** for headless `--print`
runs: without it Claude blocks on an interactive permission prompt the moment
it tries to use Bash/Edit/Write, and the task hangs or makes no changes.

We accept this because the *real* containment is elsewhere:

* Each run is confined to a throwaway git worktree on a disposable branch — if
  Claude does something wrong, discard the worktree.
* `assertCommandAllowed` refuses destructive command lines before they execute.
* Docker sandbox mode (`SANDBOX_MODE=docker`) adds cap-drop, non-root, no-new-
  privileges, and CPU/mem caps on top.

If you need stricter control, set `CLAUDE_SKIP_PERMISSIONS=false` and ship a
`.claude/settings.json` `allowedTools` allow-list inside each repo instead.

### Boundary enforcement

* Every Claude run executes inside a *throwaway* git worktree.
* `cwd` is set to the absolute worktree path; `..` cannot escape because
  `path.resolve` runs first and Docker mode mounts only that path at
  `/workspace`.
* Docker mode adds `--cap-drop ALL`, `--security-opt no-new-privileges`, a
  non-root user (`1000:1000`), and CPU/mem caps. Network defaults to
  `bridge` — set `SANDBOX_NETWORK=none` when running untrusted prompts.

### Permission model

* Only Discord user IDs listed in `DISCORD_ADMIN_IDS` can call
  `/register-repo`. Add more checks in `apps/discord-bot/src/index.ts` as
  the surface area grows.
* The API has no auth today — **do not expose it to the public internet**.
  Front it with Caddy/Nginx + basic auth or Cloudflare Access for any
  multi-tenant deployment.

### Secrets handling

* Tokens live in `.env` only (gitignored). The Pino logger has redaction
  rules for `token`, `apiKey`, `password`, `secret`, and standard auth
  headers.
* The database stores prompts and diffs but never tokens. The shell wrapper
  inherits `process.env` into children — review env passthrough before
  shipping to multi-tenant.

### Resource limits

* `CLAUDE_TIMEOUT_MS` (default 15 min) hard-kills the Claude CLI.
* `CLAUDE_MAX_OUTPUT_BYTES` (default 2 MB) truncates captured output.
* BullMQ `lockDuration` matches the task timeout so a crashed worker
  releases the job.
* `WorktreeManager.cleanupStale` can be cron-driven to prune worktrees
  older than N hours.

### Audit trail

* Every stdout/stderr chunk is persisted to `task_logs` (split into 16 KB
  rows). Final status, diff summary, and exit code live on `tasks`. The
  invoking Discord user and channel are recorded for accountability.
