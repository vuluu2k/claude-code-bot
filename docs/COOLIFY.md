# Deploy on Coolify

Step-by-step deployment of claude-code-bot on a Coolify v4 instance using the
**Docker Compose** resource type.

---

## 0. Prereqs

* A running Coolify v4 server with a server registered + Docker Compose support.
* This repo pushed to GitHub / GitLab / Gitea (Coolify will clone from it).
* Discord application + bot (see `docs/DISCORD.md` if you haven't created one).
* **Claude auth** — pick one:
  * **Claude Max / Pro + long-lived OAuth token** (recommended for Coolify): generate once with `claude setup-token` on any logged-in machine, paste the `sk-ant-oat01-…` value into Coolify env vars as `CLAUDE_CODE_OAUTH_TOKEN`. No volume, no interactive login, survives every redeploy. See [§5b option A](#option-a-long-lived-oauth-token-recommended).
  * **Claude Max / Pro + interactive login** (fallback): `claude /login` inside the worker container; tokens persist on the `ccb-claude-auth` volume. See [§5b option B](#option-b-interactive-login).
  * **Anthropic API key** (`ANTHROPIC_API_KEY` from console.anthropic.com) — for pay-as-you-go API access.
* A GitHub Personal Access Token with `repo` scope.

---

## 1. Create the Coolify resource

1. In Coolify, pick a **Project** (or create one), then **+ Add Resource → Public Repository** (or **Private Repository** if you connected GitHub).
2. Paste the repo URL, pick the branch.
3. **Build Pack** = `Docker Compose`.
4. **Docker Compose Location** = `docker-compose.coolify.yml`.
5. Click **Continue / Save**.

Coolify will parse the compose file and show 4 services: `postgres`, `redis`, `api`, `worker`, `bot`.

---

## 2. Configure environment variables

Open the **Environment Variables** tab and add the following. Use the **Build & Runtime** scope so they're available at both stages.

| Key | Required | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | Strong random string. Coolify can generate one via the dice icon. |
| `CLAUDE_CODE_OAUTH_TOKEN` | recommended for Max/Pro | Long-lived OAuth token (`sk-ant-oat01-…`). Generate via `claude setup-token`. Mark as **Is Secret**. |
| `ANTHROPIC_API_KEY` | only if no OAuth token | API key from console.anthropic.com. Mark as **Is Secret**. Leave blank when `CLAUDE_CODE_OAUTH_TOKEN` is set. |
| `GITHUB_TOKEN` | yes | PAT with `repo` scope — needed by `gh` and by `git clone` for private repos. |
| `DISCORD_TOKEN` | yes | Bot token from the Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | yes | Application ID. |
| `DISCORD_GUILD_ID` | recommended | Single guild ID → slash commands appear instantly. Leave blank for global (≤ 1 hour propagation). |
| `DISCORD_ADMIN_IDS` | recommended | Comma-separated Discord user IDs allowed to call `/register-repo`. |
| `LOG_LEVEL` | optional | `info` (default) or `debug`. |
| `SANDBOX_MODE` | optional | `host` (default). `docker` requires mounting `/var/run/docker.sock` — Coolify does **not** do this by default. |
| `WORKER_CONCURRENCY` | optional | Defaults to `2`. Increase for beefier servers. |
| `CLAUDE_TIMEOUT_MS` | optional | Per-task timeout (default `900000` = 15 min). |

Mark `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `DISCORD_TOKEN`, `POSTGRES_PASSWORD` as **Is Secret** so they're masked in the UI.

---

## 3. Expose the API (optional)

The Discord bot does **not** need a public URL — it connects outbound to Discord.
You only need a domain if you want the dashboard or HTTP API reachable from outside.

In the **api** service block:

1. Open the service → **Domains**.
2. Add a domain like `ccb-api.yourdomain.com`. Coolify will provision Let's Encrypt automatically.
3. The port mapping is already declared via `expose: 4000` in the compose file.

Front it with Coolify's built-in **Basic Auth** or Cloudflare Access — the API has no auth of its own.

---

## 4. Deploy

Click **Deploy**. Coolify will:

1. Clone the repo.
2. Build the shared image from `infra/docker/Dockerfile.app` once (api / worker / bot all reuse it).
3. Start Postgres + Redis, wait for health checks.
4. Start api, worker, bot.

First build takes ~3–5 minutes (npm installs Claude CLI + ripgrep, bun installs all workspace deps).

---

## 5. Run migrations (one-time)

Open the **api** service → **Terminal** → run:

```bash
bun --filter @ccb/db migrate
```

You should see `Migrations applied.`

---

## 5b. Authenticate Claude (one-time)

Skip this section if you already set `ANTHROPIC_API_KEY`.

### Option A — Long-lived OAuth token (recommended)

The cleanest path for any headless / container deployment.

**On any machine where you're already logged into Claude (your laptop, e.g.):**

```bash
claude setup-token
```

The CLI prints a token starting with `sk-ant-oat01-…`. Copy it.

**In Coolify:**

1. Open the resource → **Environment Variables**.
2. Add `CLAUDE_CODE_OAUTH_TOKEN` = the value you just copied. Mark **Is Secret**.
3. Redeploy (or just restart the `worker` + `api` services to pick up the new env).

Verify in the **worker** terminal:

```bash
echo "${CLAUDE_CODE_OAUTH_TOKEN:0:20}..."   # should print sk-ant-oat01-… (truncated)
claude --print 'reply with just OK'
```

Done. No volume, no interactive login, no need to re-auth after redeploys.

> **Token lifespan:** these tokens are long-lived but revocable. If you ever leak one, run `claude /logout` then `claude setup-token` again to issue a fresh one and update the Coolify env var.

### Option B — Interactive login

Use this only if `claude setup-token` isn't available in your CLI version.

Open the **worker** service → **Terminal**:

```bash
claude /login
```

The CLI prints a URL. Open it on **your** machine, log in, paste the returned code back into the terminal. Credentials cache in `/root/.claude/`, which is on the named volume `ccb-claude-auth` — so the login survives redeploys.

Verify:

```bash
claude --print 'reply with just OK'
```

---

## 6. Register Discord slash commands (one-time)

Open the **bot** service → **Terminal** → run:

```bash
bun --filter @ccb/discord-bot register
```

If `DISCORD_GUILD_ID` is set, commands appear in that guild immediately.

---

## 7. Smoke test

In your Discord server:

```
/register-repo slug:myapp url:https://github.com/<you>/<repo>.git
/repos
/repo repo:myapp task:summarize the architecture
```

You should see:

* Queued task ID
* Live streaming of Claude's output in the channel
* Final status + diff summary

---

## 8. Updating

* **Auto-deploy on push**: in Coolify → **Configuration → Source → Automatic Deployments**.
* Push to the configured branch → Coolify rebuilds + restarts the services. Migrations are **not** automatic — run step 5 again if `packages/db/src/schema.ts` changed.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Bot connects but no slash commands | Re-run step 6 (registration). Check `DISCORD_CLIENT_ID` matches the bot's app ID. |
| Tasks stuck in `queued` | Check the **worker** logs — likely a Redis or DB connection error, or missing `ANTHROPIC_API_KEY`. |
| `Command claude failed: ENOENT` | Image build skipped the CLI install. Trigger a clean rebuild (Coolify → **Redeploy without cache**). |
| `Authentication required` from Claude | `ANTHROPIC_API_KEY` not set, or invalid. Verify in the worker terminal: `printenv ANTHROPIC_API_KEY`. |
| `permission denied` cloning a private repo | `GITHUB_TOKEN` missing or lacks `repo` scope. The clone uses HTTPS + the token. |
| `relation "repos" does not exist` | Step 5 (migrations) was skipped. |
| Worker dies, restarts in a loop | Check **Logs**. Most common cause: Redis URL points to localhost — verify `REDIS_URL=redis://redis:6379` in env. |

---

## 10. Hardening (recommended for any internet-exposed deployment)

* Front the API with Coolify Basic Auth or Cloudflare Access.
* Set `DISCORD_ADMIN_IDS` so only you can register repos.
* Pin specific image tags (currently `postgres:16-alpine`, `redis:7-alpine`) and review them on upgrade.
* Back up the `ccb-pgdata` and `ccb-workspaces` volumes — Coolify → **Resource → Storages**.
* Rotate `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` on a schedule.
