# Discord setup

## 1. Create the application

1. Visit https://discord.com/developers/applications and click **New Application**.
2. In **Bot**, click **Reset Token** and copy the value → `DISCORD_TOKEN`.
3. Copy the **Application ID** from the General Information page → `DISCORD_CLIENT_ID`.
4. Under **Privileged Gateway Intents**, turn **MESSAGE CONTENT INTENT** **ON**. Required for thread-as-session mode so the bot can read the follow-up messages you type inside a task thread. (Server Members intent is not needed.)

## 2. Invite it to your server

OAuth2 → URL Generator:

* Scopes: `bot`, `applications.commands`
* Bot permissions: `Send Messages`, `Embed Links`, `Use Slash Commands`,
  `Read Message History`, `Attach Files`, `Add Reactions`,
  **`Create Public Threads`**, **`Send Messages in Threads`**

Open the generated URL, pick your guild, authorize.

## 3. Get the guild ID

In Discord, enable Developer Mode (User Settings → Advanced), then right-click
the server icon → **Copy Server ID** → set as `DISCORD_GUILD_ID`. Guild-scoped
commands appear immediately (global ones take up to an hour).

## 4. Set admin IDs

Right-click your user → **Copy User ID**. Add it to `DISCORD_ADMIN_IDS` (comma
separated). Admins can call privileged commands like `/register-repo`.

## 5. Register slash commands

```bash
bun run bot:register
```

You should see:

```
Registering 8 guild commands → guild 1234567890
Commands registered.
```

## 6. Test it

```
/repos
/register-repo slug:myapp url:https://github.com/me/myapp.git
/repo repo:myapp task:summarize the project structure
```

You'll see a live stream of Claude's output in the channel, followed by a
status line and a diff preview when it finishes.

## Command reference

| Command | What it does |
|---------|--------------|
| `/repos` | List registered repositories |
| `/register-repo` | (admin) clone a new repo and register it |
| `/repo` | Queue a Claude task with live streaming |
| `/status` | Show task status, branch, diff summary |
| `/diff` | Show diff preview for a task |
| `/logs` | Tail the persisted log chunks |
| `/session new` / `/session list` | Manage repo-scoped sessions |
| `/cancel` | Send a cancellation signal to a running task |
| `/pr` | (in a thread) push the branch and open/update a pull request |

## Thread-as-session mode (like terminal Claude Code)

Running `/repo` opens a **thread**. That thread is a live Claude session — just
keep typing in it and Claude retains full context and edits the **same**
worktree across turns, exactly like an interactive `claude` terminal.

```
/repo myapp đọc module auth và giải thích
  └─ 🧵 Thread "myapp · đọc module auth…"
     Bot:  [streams Claude's explanation]
     You:  giờ fix cái bug redirect sau login          ← just type, no slash
     Bot:  [resumes session, edits files, streams]
     You:  chạy test rồi commit lại
     Bot:  [resumes again, runs tests, commits]
     Bot:  Diff: 3 file(s), +47/-12
```

How it works:

* Each thread is bound to a repo + a persistent git worktree (`workspaces/worktrees/<repo>/<threadId>`).
* Every message you type resumes Claude's CLI session via `--resume`, so the
  conversation memory carries over.
* The worktree is **not** thrown away between messages — file edits accumulate
  until the thread is closed.
* **Opening a PR** is user-triggered — three ways:
  * Run `/pr` (optionally `/pr title:...`) inside the thread.
  * **Just chat it**: a short message like *"tạo PR"*, *"mở pull request giúp"*,
    or *"create a PR"* is detected and opens the PR directly (fast path).
  * Ask Claude with a richer instruction: *"fix lint rồi tạo pull request"* — the
    full task runs, and Claude pushes + opens the PR itself.
  All three commit, push the thread branch (`ccb/<threadId>`), and open or update
  the PR, then post the link. Follow-up commits go to the same PR. Requires
  `GITHUB_TOKEN` with write access. Set `AUTO_PR=true` for fully automatic PRs.

Notes:

* Requires the **MESSAGE CONTENT** privileged intent (step 1.4) and the
  **Create Public Threads** / **Send Messages in Threads** permissions.
* Use `/cancel task_id:<id>` to interrupt a running turn (the equivalent of
  pressing Esc in the terminal).
* One-off `/status`, `/diff`, `/logs` still work against any task id printed in
  the thread.

## @mention — casual chat (no repo)

Mention the bot in any normal channel to just talk to Claude — no repo, no
worktree, no thread needed:

```
@claude-code-bot 2 + 2 bằng mấy?
@claude-code-bot giải thích thuật toán quicksort ngắn gọn
@claude-code-bot viết regex match email
```

* The bot runs Claude in a per-channel scratch dir and replies inline.
* **Reads context**: it pulls the last `CHAT_CONTEXT_MESSAGES` channel messages
  (default 15) plus the message you're replying to, so you can ask things like
  *"@bot tóm tắt những gì tụi mình vừa bàn"* or reply to a code snippet and ask
  *"@bot fix cái này"* without re-pasting.
* The bot only responds when **directly @mentioned** in normal channels (it
  ignores everything else to avoid noise). Inside task threads you don't need to
  mention it — just type.
* Set `CHAT_CONTEXT_MESSAGES=0` to disable context gathering (answer only the
  mention text).

Requires `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) to be set on the
**bot** service too — see docs/COOLIFY.md.

## Status reactions

The bot reacts to your message so you can see progress at a glance (needs the
**Add Reactions** permission):

| Reaction | Meaning |
|----------|---------|
| 👀 | đang làm / running |
| 🎉 | xong / done |
| 💀 | lỗi / failed |
| ✋ | đã huỷ / cancelled |
| 🐢 | quá giờ / timeout |

## Two interaction modes at a glance

| Where | How to talk | Backed by |
|-------|-------------|-----------|
| Normal channel | `/repo …` (start) or `@mention` (chat) | thread+worktree / scratch chat |
| Inside a task thread | type normally, no slash | persistent worktree + `--resume` |
