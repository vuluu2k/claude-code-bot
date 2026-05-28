import {
  Client,
  GatewayIntentBits,
  Events,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type Interaction,
  type Message,
  type AnyThreadChannel,
  type TextBasedChannel,
} from "discord.js";
import IORedis from "ioredis";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";
import { run } from "@ccb/shared/shell";
import { EVENT_CHANNEL, type StreamEvent } from "@ccb/shared";
import { client as api } from "./api-client.js";
import { registerCommands } from "./register-commands.js";

const log = makeLogger("discord-bot");
const cfg = loadConfig();

if (!cfg.discord.token) {
  console.error("DISCORD_TOKEN is required to start the bot.");
  process.exit(1);
}

// MessageContent is a privileged intent — enable it in the Discord Developer
// Portal (Bot → Privileged Gateway Intents). Required so the bot can read
// follow-up messages typed inside a task thread.
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const redis = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------
function isAdmin(userId: string): boolean {
  return cfg.discord.adminIds.includes(userId);
}

function chunk(s: string, max = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out.length ? out : [""];
}

function codeBlock(s: string, lang = "") {
  return "```" + lang + "\n" + s + "\n```";
}

/**
 * Render one line of Claude's `stream-json` output into chat-style text for
 * Discord. We surface only the assistant's natural-language replies so a thread
 * reads like a conversation — not an agent trace. Everything else (system init,
 * thinking, tool calls, tool results, rate-limit pings, the duplicate final
 * success result) is dropped.
 */
function renderClaudeStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let ev: any;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null; // partial / non-JSON output — ignore
  }
  switch (ev?.type) {
    case "assistant": {
      const blocks = ev.message?.content;
      if (!Array.isArray(blocks)) return null;
      const out: string[] = [];
      for (const b of blocks) {
        // Only spoken text — skip thinking, tool_use, and other block types.
        if (b?.type === "text" && b.text?.trim()) out.push(b.text.trim());
      }
      return out.length ? out.join("\n\n") : null;
    }
    case "result":
      // The success result just repeats the final assistant text we already
      // streamed — only surface genuine errors here.
      if (ev.is_error && typeof ev.result === "string") return `⚠️ ${ev.result.trim()}`;
      return null;
    default:
      // system / user(tool_result) / rate_limit_event / stream_event → skip
      return null;
  }
}

/** Drop noise lines from Claude's stderr (e.g. the harmless stdin warning). */
function cleanStderr(data: string): string {
  return data
    .split("\n")
    .filter((l) => l.trim() && !/no stdin data received/i.test(l))
    .join("\n");
}

// Playful status reactions on the triggering message.
const RUNNING_EMOJI = "👀"; // đang làm
const STATUS_EMOJIS = ["👀", "🎉", "💀", "✋", "🐢"] as const;

async function safeReact(message: Message, emoji: string) {
  try {
    await message.react(emoji);
  } catch {
    /* missing Add Reactions permission — ignore */
  }
}

/** Set a single status emoji, removing the bot's previous status reactions. */
async function setStatus(message: Message, emoji: string) {
  if (!bot.user) return;
  for (const e of STATUS_EMOJIS) {
    if (e === emoji) continue;
    const r = message.reactions.cache.get(e);
    if (r) await r.users.remove(bot.user.id).catch(() => {});
  }
  await safeReact(message, emoji);
}

const statusEmojiForTask: Record<string, string> = {
  succeeded: "🎉",
  failed: "💀",
  cancelled: "✋",
  timeout: "🐢",
};

// Per-thread Claude model selection (set via /model), keyed by Discord thread
// id. In-memory only: it resets to the CLI default when the bot restarts. The
// sentinel "default" means "don't pass --model" — handled by clearing the entry.
const threadModel = new Map<string, string>();

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function handleRepos(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  const { repos } = await api.listRepos();
  if (!repos.length) {
    await i.editReply("No repositories registered yet. Use `/register-repo`.");
    return;
  }
  const lines = repos.map((r) => `• **${r.slug}** — ${r.remoteUrl} (${r.defaultBranch})`);
  await i.editReply(lines.join("\n"));
}

async function handleRegisterRepo(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) {
    await i.reply({ content: "Not authorized.", ephemeral: true });
    return;
  }
  const slug = i.options.getString("slug", true);
  const url = i.options.getString("url", true);
  const branch = i.options.getString("branch") ?? undefined;
  await i.deferReply({ ephemeral: true });
  try {
    const { repo } = await api.registerRepo(slug, url, branch);
    await i.editReply(`Registered **${repo.slug}** → ${repo.remoteUrl} (${repo.defaultBranch})`);
  } catch (err) {
    log.error({ err }, "register-repo failed");
    await i.editReply(`Failed: ${(err as Error).message}`);
  }
}

async function handleRepoTask(i: ChatInputCommandInteraction) {
  const repoSlug = i.options.getString("repo", true);
  const task = i.options.getString("task", true);
  const base = i.options.getString("base") ?? undefined;
  await i.deferReply();

  // A task starts a thread. The thread = a persistent Claude session: type
  // follow-up messages in it and Claude keeps full context + the same worktree.
  const reply = await i.editReply(
    `Starting **${repoSlug}** — opening a thread for this session…`,
  );

  let thread: AnyThreadChannel;
  try {
    thread = await reply.startThread({
      name: `${repoSlug} · ${task.slice(0, 60)}`,
      autoArchiveDuration: 1440, // 24h
    });
  } catch (err) {
    await i.editReply(
      `Couldn't open a thread (need "Create Public Threads" permission): ${(err as Error).message}`,
    );
    return;
  }

  try {
    await api.registerThread({
      id: thread.id,
      repoSlug,
      channelId: i.channelId,
      createdBy: i.user.id,
    });
  } catch (err) {
    await thread.send(`Failed to register thread: ${(err as Error).message}`);
    return;
  }

  await runThreadTask(thread, {
    repoSlug,
    prompt: task,
    requestedBy: i.user.id,
    baseBranch: base,
  });
}

/**
 * Queue a task bound to a thread and stream Claude's output into that thread.
 * Used both for the first `/repo` message and every follow-up typed in-thread.
 */
async function runThreadTask(
  thread: AnyThreadChannel,
  input: {
    repoSlug: string;
    prompt: string;
    requestedBy: string;
    baseBranch?: string;
    reactTarget?: Message;
  },
) {
  let taskId: string;
  try {
    const created = await api.createTask({
      repoSlug: input.repoSlug,
      prompt: input.prompt,
      requestedBy: input.requestedBy,
      channelId: thread.id,
      threadId: thread.id,
      baseBranch: input.baseBranch,
      // Per-thread model picked via /model (undefined → CLI default).
      model: threadModel.get(thread.id),
    });
    taskId = created.task.id;
  } catch (err) {
    if (input.reactTarget) await setStatus(input.reactTarget, "💀");
    await thread.send(`Failed to queue task: ${(err as Error).message}`).catch(() => {});
    return;
  }
  await streamTaskToChannel(thread, taskId, input.reactTarget);
}

/**
 * Subscribe to a task's Redis event channel and relay output into a Discord
 * channel (a thread). Throttles writes to respect Discord rate limits.
 */
async function streamTaskToChannel(
  channel: TextBasedChannel,
  taskId: string,
  reactTarget?: Message,
) {
  if (!("send" in channel)) return;
  const sub = redis.duplicate();
  const eventChannel = EVENT_CHANNEL(taskId);
  await sub.subscribe(eventChannel);

  let buffer = ""; // rendered, human-readable text waiting to be sent
  let lineBuffer = ""; // raw stream-json bytes not yet terminated by a newline
  let lastFlush = Date.now();
  const append = (text: string) => {
    if (text) buffer += (buffer ? "\n\n" : "") + text;
  };
  const flush = async () => {
    if (!buffer.trim()) return;
    const out = buffer;
    buffer = "";
    for (const part of chunk(out)) {
      await channel.send(part).catch(() => {});
    }
  };

  // Claude emits one JSON object per line. Chunks may split a line, so buffer
  // until a newline, then render each complete line into readable text.
  const ingest = (data: string) => {
    lineBuffer += data;
    let nl: number;
    while ((nl = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, nl).trim();
      lineBuffer = lineBuffer.slice(nl + 1);
      if (!line) continue;
      // JSON lines are Claude stream-json events; anything else is a plain-text
      // notice the worker injected (e.g. the auto-PR link) — show it verbatim.
      if (line.startsWith("{")) append(renderClaudeStreamLine(line) ?? "");
      else append(line);
    }
  };

  const flushTimer = setInterval(() => {
    if (buffer.length > 0 && Date.now() - lastFlush > 2_500) {
      lastFlush = Date.now();
      flush().catch(() => {});
    }
  }, 1_000);

  sub.on("message", async (ch, msg) => {
    if (ch !== eventChannel) return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(msg) as StreamEvent;
    } catch {
      return;
    }
    if (ev.type === "stdout") {
      ingest(ev.data);
      if (buffer.length > 1_500) {
        lastFlush = Date.now();
        await flush();
      }
    } else if (ev.type === "stderr") {
      append(cleanStderr(ev.data)); // stderr is plain text, not stream-json
      if (buffer.length > 1_500) {
        lastFlush = Date.now();
        await flush();
      }
    } else if (ev.type === "status") {
      // Render any trailing partial line before the final flush.
      const tail = renderClaudeStreamLine(lineBuffer);
      lineBuffer = "";
      if (tail) append(tail);
      await flush();
      if (["succeeded", "failed", "cancelled", "timeout"].includes(ev.status)) {
        clearInterval(flushTimer);
        sub.unsubscribe(eventChannel).catch(() => {});
        sub.disconnect();
        // Chat-style: status is conveyed only by the emoji reaction on the
        // triggering message — no robotic "Task → status" line or diff dump.
        // Use /diff to inspect changes when needed.
        if (reactTarget) await setStatus(reactTarget, statusEmojiForTask[ev.status] ?? "🎉");
      }
    }
  });

  setTimeout(() => {
    clearInterval(flushTimer);
    sub.disconnect();
  }, 30 * 60 * 1000).unref();
}

/**
 * Follow-up messages typed inside a task thread continue the same Claude
 * session. We look the thread up via the API; unregistered threads are ignored.
 */
async function handleThreadMessage(message: Message) {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const content = message.content.trim();
  if (!content) return;
  // Ignore commands and our own status lines.
  if (content.startsWith("/")) return;

  let thread;
  try {
    const res = await api.getThread(message.channelId);
    thread = res.thread;
  } catch {
    return; // not a registered task thread
  }
  if (thread.status !== "active") return;

  // Shortcut: a short, standalone "cancel"/"huỷ" message stops the task that's
  // currently running in this thread. Because we no longer print task ids in
  // chat-style threads, this is the only ergonomic way to cancel — the API
  // resolves the active task from the thread id for us. Mixed instructions
  // (e.g. "dừng việc đó rồi làm cái khác") are too long to match and go to Claude.
  if (looksLikeCancelRequest(content)) {
    await setStatus(message, "✋");
    try {
      const { ok } = await api.cancelThread(message.channelId);
      await message.channel
        .send(ok ? "Đã huỷ task đang chạy." : "Hiện không có task nào đang chạy để huỷ.")
        .catch(() => {});
    } catch (err) {
      await message.channel.send(`Huỷ thất bại: ${(err as Error).message}`).catch(() => {});
    }
    return;
  }

  // Shortcut: a short, standalone "create PR" message opens the PR directly
  // (commit + push + gh pr) without spinning up a full Claude task. Longer or
  // mixed instructions (e.g. "fix the bug then make a PR") go to Claude.
  if (looksLikePrRequest(content)) {
    await setStatus(message, RUNNING_EMOJI);
    try {
      const { pr, reason } = await api.createPr(message.channelId);
      await message.channel
        .send(pr ? `🔗 Pull request: ${pr}` : `Chưa tạo PR: ${reason ?? "không có thay đổi"}`)
        .catch(() => {});
      await setStatus(message, pr ? "🎉" : "💀");
    } catch (err) {
      await setStatus(message, "💀");
      await message.channel.send(`Tạo PR thất bại: ${(err as Error).message}`).catch(() => {});
    }
    return;
  }

  await setStatus(message, RUNNING_EMOJI);
  await message.channel.sendTyping().catch(() => {});
  await runThreadTask(message.channel as AnyThreadChannel, {
    repoSlug: thread.repoSlug,
    prompt: content,
    requestedBy: message.author.id,
    reactTarget: message,
  });
}

/**
 * Heuristic: is this short thread message just asking to open a PR? Kept
 * conservative — only fires on short, standalone requests so mixed instructions
 * ("fix X then open a PR") still go to Claude.
 */
function looksLikePrRequest(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length > 60) return false;
  const mentionsPr = /\b(pull request|pull req|pr|mr)\b/.test(t) || /tạo\s*pull/.test(t);
  if (!mentionsPr) return false;
  // Require an action verb or be a very short bare request.
  const hasVerb = /(tạo|mở|gửi|đẩy|push|create|open|make|raise|submit)/.test(t);
  return hasVerb || t.length <= 12;
}

/**
 * Heuristic: is this short thread message asking to stop the running task?
 * Kept deliberately conservative: only fires on short messages that *start*
 * with a cancel verb followed by a boundary, so "stopwatch feature" or longer
 * mixed instructions still go to Claude rather than aborting by accident.
 * Covers both English (cancel/stop/abort) and Vietnamese (huỷ/hủy/dừng/ngừng).
 */
function looksLikeCancelRequest(text: string): boolean {
  // Strip trailing punctuation so "huỷ!" / "stop." still match.
  const t = text.toLowerCase().trim().replace(/[.!?…]+$/u, "").trim();
  if (t.length > 24) return false;
  return /^(cancel|stop|abort|huỷ|hủy|dừng|ngừng)(\s|$)/u.test(t);
}

const CHAT_TIMEOUT_MS = 180_000;
// How many recent channel messages to feed Claude as context (env-tunable).
const CHAT_CONTEXT_MESSAGES = Math.max(
  0,
  Math.min(Number(process.env.CHAT_CONTEXT_MESSAGES ?? 15), 50),
);
// Model for @mention chat. Default to the most capable model; override via env.
const CHAT_MODEL = process.env.CHAT_MODEL ?? "opus";

function displayName(m: Message): string {
  if (bot.user && m.author.id === bot.user.id) return "Bot";
  return m.member?.displayName ?? m.author.username;
}

/** One context line: "[Name]: text" with mentions cleaned + truncated. */
function contextLine(m: Message, max = 300): string {
  let text = m.content.replace(/<@!?\d+>/g, "@user").trim();
  if (!text && m.attachments.size) text = "[attachment]";
  if (!text && m.embeds.length) text = "[embed]";
  if (!text) return "";
  if (text.length > max) text = text.slice(0, max) + "…";
  return `[${displayName(m)}]: ${text}`;
}

/**
 * Assemble the chat prompt from (A) recent channel messages and (B) the message
 * being replied to, plus the current question. Gives Claude real conversational
 * context instead of just the bare mention.
 */
async function buildChatPrompt(message: Message, question: string): Promise<string> {
  const parts: string[] = [
    "Bạn là một trợ lý thông minh, thân thiện trong một kênh chat Discord. " +
      "Bạn CÓ quyền dùng công cụ: web search/web fetch để tra cứu thông tin thực tế " +
      "(thời tiết, tin tức, giá cả, tài liệu...), và đọc/chạy lệnh khi cần. " +
      "Khi câu hỏi cần dữ liệu thời gian thực hoặc bạn không chắc, HÃY dùng web search " +
      "để tìm rồi trả lời kèm nguồn — đừng nói 'mình không kiểm tra được'. " +
      "Trả lời ngắn gọn, đúng trọng tâm.",
  ];

  // (A) Recent channel messages, oldest → newest, excluding this one.
  if (CHAT_CONTEXT_MESSAGES > 0 && "messages" in message.channel) {
    try {
      const fetched = await message.channel.messages.fetch({
        limit: CHAT_CONTEXT_MESSAGES,
        before: message.id,
      });
      const lines = [...fetched.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => contextLine(m))
        .filter(Boolean);
      if (lines.length) {
        parts.push("## Bối cảnh kênh gần đây (cũ → mới)\n" + lines.join("\n"));
      }
    } catch {
      /* missing Read Message History — skip context */
    }
  }

  // (B) The message this mention is replying to, if any.
  if (message.reference?.messageId) {
    try {
      const ref = await message.fetchReference();
      const line = contextLine(ref, 800);
      if (line) parts.push("## Đang trả lời tin nhắn\n" + line);
    } catch {
      /* deleted / inaccessible — skip */
    }
  }

  parts.push(`## Tin nhắn hiện tại (từ ${displayName(message)})\n${question}`);
  parts.push(
    "Hãy trả lời tin nhắn hiện tại, dùng bối cảnh ở trên khi liên quan. " +
      "Trả lời bằng ngôn ngữ của người dùng, ngắn gọn và thân thiện.",
  );
  return parts.join("\n\n");
}

/**
 * Casual chat: when the bot is @mentioned in a normal channel (not a task
 * thread), run Claude in a per-channel scratch dir and reply. Pulls recent
 * channel messages + any replied-to message in as context.
 */
async function handleMention(message: Message) {
  if (message.author.bot) return;
  if (message.mentions.everyone) return;
  if (!bot.user || !message.mentions.users.has(bot.user.id)) return;
  if (!("send" in message.channel)) return;
  const channel = message.channel;

  const text = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!text) {
    await message
      .reply("Tag mình kèm nội dung nhé, ví dụ: `@bot 2+2 bằng mấy?`")
      .catch(() => {});
    return;
  }

  const scratch = path.join(cfg.workspace.root, "chat", message.channelId);
  await fs.mkdir(scratch, { recursive: true });

  await setStatus(message, RUNNING_EMOJI);
  await channel.sendTyping().catch(() => {});
  const typing = setInterval(() => channel.sendTyping().catch(() => {}), 8_000);

  const prompt = await buildChatPrompt(message, text);
  const args = ["--print", "--dangerously-skip-permissions"];
  if (CHAT_MODEL) args.push("--model", CHAT_MODEL);
  args.push(prompt);

  const env: Record<string, string> = {};
  if (cfg.claude.apiKey) env.ANTHROPIC_API_KEY = cfg.claude.apiKey;
  if (cfg.claude.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = cfg.claude.oauthToken;

  try {
    const res = await run(cfg.claude.bin, args, {
      cwd: scratch,
      env,
      timeoutMs: CHAT_TIMEOUT_MS,
      maxOutputBytes: 200_000,
      allowFailure: true,
    });
    clearInterval(typing);
    const out = (res.stdout || res.stderr || "").trim() || "(không có phản hồi)";
    for (const part of chunk(out, 1990)) {
      await channel.send(part).catch(() => {});
    }
    await setStatus(message, res.exitCode === 0 ? "🎉" : "💀");
  } catch (err) {
    clearInterval(typing);
    await setStatus(message, "💀");
    log.error({ err, channelId: message.channelId }, "chat run failed");
    await channel.send(`Lỗi khi chat: ${(err as Error).message}`).catch(() => {});
  }
}

/**
 * Resolve the task id a command should act on: the explicit `task_id` option if
 * given, otherwise — when run inside a thread — that thread's most recent task.
 * Returns undefined when neither applies, so callers can show a helpful hint.
 */
async function resolveTaskId(i: ChatInputCommandInteraction): Promise<string | undefined> {
  const explicit = i.options.getString("task_id");
  if (explicit) return explicit;
  if (i.channel?.isThread()) {
    const { task } = await api.latestThreadTask(i.channelId);
    return task?.id;
  }
  return undefined;
}

async function handleStatus(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const id = await resolveTaskId(i);
    if (!id) {
      await i.editReply("Cần `task_id`, hoặc dùng `/status` trong thread để xem task gần nhất.");
      return;
    }
    const { task } = await api.getTask(id);
    await i.editReply(
      `**${task.id}** [${task.status}]\n` +
        `Repo: ${task.repoSlug}\nBranch: ${task.branch ?? "-"}\n` +
        `Diff: ${task.diffSummary ?? "-"}\n` +
        `Created: ${task.createdAt}`,
    );
  } catch (err) {
    await i.editReply(`Not found or failed: ${(err as Error).message}`);
  }
}

async function handleDiff(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const id = await resolveTaskId(i);
    if (!id) {
      await i.editReply("Cần `task_id`, hoặc dùng `/diff` trong thread để xem thay đổi hiện tại.");
      return;
    }
    const { diff } = await api.getDiff(id);
    if (!diff) {
      await i.editReply("Chưa có diff (worktree chưa được khởi tạo).");
      return;
    }
    if (!diff.hasChanges) {
      await i.editReply("Không có thay đổi nào.");
      return;
    }
    await i.editReply(
      `${diff.totalFiles} file(s), +${diff.insertions}/-${diff.deletions}\n` +
        codeBlock(diff.preview.slice(0, 1800), "diff"),
    );
  } catch (err) {
    await i.editReply(`Failed: ${(err as Error).message}`);
  }
}

async function handleLogs(i: ChatInputCommandInteraction) {
  const id = i.options.getString("task_id", true);
  const limit = i.options.getInteger("limit") ?? 60;
  await i.deferReply({ ephemeral: true });
  try {
    const { logs } = await api.getLogs(id);
    const slice = logs.slice(-limit);
    const joined = slice.map((l) => l.chunk).join("");
    if (!joined.trim()) {
      await i.editReply("No logs yet.");
      return;
    }
    for (const part of chunk(codeBlock(joined.slice(-1800)))) {
      await i.followUp({ content: part, ephemeral: true });
    }
    await i.editReply(`${slice.length} log chunk(s)`);
  } catch (err) {
    await i.editReply(`Failed: ${(err as Error).message}`);
  }
}

async function handleSession(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();
  await i.deferReply({ ephemeral: true });
  try {
    if (sub === "new") {
      const repo = i.options.getString("repo", true);
      const title = i.options.getString("title") ?? undefined;
      const { session } = await api.createSession(repo, title);
      await i.editReply(`Session \`${session.id}\` created.`);
    } else {
      const repo = i.options.getString("repo") ?? undefined;
      const { sessions } = await api.listSessions(repo);
      const lines = sessions.slice(0, 20).map((s) => `• ${s.id} — ${s.title ?? "(untitled)"} (${s.repoSlug})`);
      await i.editReply(lines.length ? lines.join("\n") : "No sessions.");
    }
  } catch (err) {
    await i.editReply(`Failed: ${(err as Error).message}`);
  }
}

async function handlePr(i: ChatInputCommandInteraction) {
  const title = i.options.getString("title") ?? undefined;
  if (!i.channel?.isThread()) {
    await i.reply({
      content: "Dùng `/pr` bên trong một thread do `/repo` tạo nhé.",
      ephemeral: true,
    });
    return;
  }
  await i.deferReply();
  try {
    const { pr, reason } = await api.createPr(i.channelId, title);
    if (pr) {
      await i.editReply(`🔗 Pull request: ${pr}`);
    } else {
      await i.editReply(`Không tạo PR: ${reason ?? "không có thay đổi"}`);
    }
  } catch (err) {
    await i.editReply(`Tạo PR thất bại: ${(err as Error).message}`);
  }
}

async function handleCancel(i: ChatInputCommandInteraction) {
  // task_id is optional now: inside a thread you can just run `/cancel` and we
  // cancel that thread's running task. The explicit id is still accepted for
  // cancelling a task from anywhere (e.g. another channel).
  const id = i.options.getString("task_id");
  await i.deferReply({ ephemeral: true });
  try {
    if (id) {
      await api.cancelTask(id);
      await i.editReply(`Đã gửi tín hiệu huỷ cho \`${id}\`.`);
      return;
    }
    if (i.channel?.isThread()) {
      const { ok } = await api.cancelThread(i.channelId);
      await i.editReply(ok ? "Đã huỷ task đang chạy trong thread này." : "Hiện không có task nào đang chạy.");
      return;
    }
    // No id and not in a thread — we have nothing to target.
    await i.editReply("Cần `task_id`, hoặc gõ `/cancel` ngay trong thread để huỷ task đang chạy ở đó.");
  } catch (err) {
    await i.editReply(`Thất bại: ${(err as Error).message}`);
  }
}

// /model — set which Claude model this thread uses. Stored in-memory per thread
// and applied to the next message. "default" clears the override.
async function handleModel(i: ChatInputCommandInteraction) {
  const name = i.options.getString("name", true);
  await i.deferReply({ ephemeral: true });
  if (!i.channel?.isThread()) {
    await i.editReply("Dùng `/model` bên trong một thread do `/repo` tạo nhé.");
    return;
  }
  if (name === "default") {
    threadModel.delete(i.channelId);
    await i.editReply("Đã đặt model về **mặc định** của CLI cho thread này.");
  } else {
    threadModel.set(i.channelId, name);
    await i.editReply(`Đã đặt model thành **${name}** cho thread này (áp dụng từ tin nhắn kế tiếp).`);
  }
}

// /new — fresh conversation in this thread; the worktree (code) is kept but the
// Claude context is forgotten so the next message starts a new session.
async function handleNew(i: ChatInputCommandInteraction) {
  await i.deferReply();
  if (!i.channel?.isThread()) {
    await i.editReply("Dùng `/new` bên trong một thread do `/repo` tạo nhé.");
    return;
  }
  try {
    await api.newThread(i.channelId);
    await i.editReply("Bắt đầu hội thoại mới trong thread này (giữ nguyên code, quên ngữ cảnh cũ).");
  } catch (err) {
    await i.editReply(`Thất bại: ${(err as Error).message}`);
  }
}

// /resume — reactivate a closed/archived thread so it accepts messages again.
async function handleResume(i: ChatInputCommandInteraction) {
  await i.deferReply();
  if (!i.channel?.isThread()) {
    await i.editReply("Dùng `/resume` bên trong một thread do `/repo` tạo nhé.");
    return;
  }
  try {
    const { resumed } = await api.resumeThread(i.channelId);
    await i.editReply(
      resumed
        ? "Đã tiếp tục hội thoại — cứ nhắn tiếp, Claude vẫn nhớ ngữ cảnh trước đó."
        : "Thread đã sẵn sàng — cứ nhắn để bắt đầu (chưa có ngữ cảnh trước đó).",
    );
  } catch (err) {
    await i.editReply(`Thất bại: ${(err as Error).message}`);
  }
}

// /rewind — discard ALL changes in this thread's worktree, back to base branch.
async function handleRewind(i: ChatInputCommandInteraction) {
  await i.deferReply();
  if (!i.channel?.isThread()) {
    await i.editReply("Dùng `/rewind` bên trong một thread do `/repo` tạo nhé.");
    return;
  }
  try {
    const { discarded } = await api.rewindThread(i.channelId);
    await i.editReply(`Đã hoàn tác mọi thay đổi trong thread (về nhánh gốc). Đã bỏ: ${discarded}.`);
  } catch (err) {
    await i.editReply(`Rewind thất bại: ${(err as Error).message}`);
  }
}

// /end — close this thread; the ThreadUpdate/Delete handlers free its worktree.
async function handleEnd(i: ChatInputCommandInteraction) {
  if (!i.channel?.isThread()) {
    await i.reply({ content: "Dùng `/end` bên trong một thread do `/repo` tạo nhé.", ephemeral: true });
    return;
  }
  await i.deferReply();
  try {
    await api.closeThread(i.channelId);
    await i.editReply("Đã đóng thread. Tạo `/repo` mới để bắt đầu phiên khác.");
    // Archiving needs Manage Threads — best-effort, ignore if missing.
    await i.channel.setArchived(true).catch(() => {});
  } catch (err) {
    await i.editReply(`Không đóng được: ${(err as Error).message}`);
  }
}

// /tasks — list recent tasks, newest first, optionally filtered by repo.
async function handleTasks(i: ChatInputCommandInteraction) {
  const repo = i.options.getString("repo") ?? undefined;
  await i.deferReply({ ephemeral: true });
  try {
    const { tasks } = await api.listTasks(repo, 15);
    if (!tasks.length) {
      await i.editReply("Chưa có task nào.");
      return;
    }
    const lines = tasks.map(
      (t) => `• \`${t.id}\` [${t.status}] **${t.repoSlug}** — ${t.prompt.slice(0, 50)}`,
    );
    await i.editReply(lines.join("\n").slice(0, 1900));
  } catch (err) {
    await i.editReply(`Thất bại: ${(err as Error).message}`);
  }
}

// /help — quick reference for how the bot and its threads work.
async function handleHelp(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  await i.editReply(
    [
      "**Cách dùng bot**",
      "",
      "`/repo` mở một **thread** cho task. Cứ nhắn tiếp trong thread để Claude làm tiếp — giữ nguyên ngữ cảnh và worktree.",
      "",
      "Trong thread bạn có thể gõ thẳng:",
      "• `huỷ` / `dừng` / `cancel` — dừng task đang chạy",
      "• `tạo PR` — mở pull request",
      "",
      "Lệnh điều khiển hội thoại (giống Claude Code):",
      "• `/model` — chọn model (opus/sonnet/haiku)",
      "• `/new` — bắt đầu hội thoại mới (giữ code)",
      "• `/resume` — tiếp tục thread đã đóng",
      "• `/rewind` — bỏ hết thay đổi, về nhánh gốc",
      "• `/end` — đóng thread, dọn worktree",
      "",
      "Lệnh thông tin (trong thread không cần task id):",
      "• `/diff` — xem thay đổi code",
      "• `/status` — trạng thái task",
      "• `/pr` — đẩy nhánh và mở pull request",
      "• `/tasks` — liệt kê task gần đây",
      "• `/repos`, `/register-repo`, `/session` — quản lý repo/session",
      "",
      "Tag `@bot` ở kênh thường để hỏi đáp nhanh (không cần repo).",
    ].join("\n"),
  );
}

async function handleAutocomplete(i: AutocompleteInteraction) {
  if (i.commandName !== "repo") return;
  const focused = i.options.getFocused(true);
  if (focused.name !== "repo") return;
  try {
    const { repos } = await api.listRepos();
    const q = focused.value.toLowerCase();
    const matches = repos
      .filter((r) => r.slug.toLowerCase().includes(q))
      .slice(0, 25)
      .map((r) => ({ name: r.slug, value: r.slug }));
    await i.respond(matches);
  } catch {
    await i.respond([]);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
bot.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag }, "bot online");
  // Keep slash commands in sync on every boot unless disabled.
  if (process.env.AUTO_REGISTER_COMMANDS !== "false") {
    try {
      await registerCommands();
    } catch (err) {
      log.error({ err }, "auto-registering commands failed");
    }
  }
});

bot.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case "repos":
        return handleRepos(interaction);
      case "register-repo":
        return handleRegisterRepo(interaction);
      case "repo":
        return handleRepoTask(interaction);
      case "status":
        return handleStatus(interaction);
      case "diff":
        return handleDiff(interaction);
      case "logs":
        return handleLogs(interaction);
      case "session":
        return handleSession(interaction);
      case "cancel":
        return handleCancel(interaction);
      case "pr":
        return handlePr(interaction);
      case "model":
        return handleModel(interaction);
      case "new":
        return handleNew(interaction);
      case "resume":
        return handleResume(interaction);
      case "rewind":
        return handleRewind(interaction);
      case "end":
        return handleEnd(interaction);
      case "tasks":
        return handleTasks(interaction);
      case "help":
        return handleHelp(interaction);
    }
  } catch (err) {
    log.error({ err }, "interaction handler crashed");
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction
        .reply({ content: `Internal error: ${(err as Error).message}`, ephemeral: true })
        .catch(() => {});
    }
  }
});

// Message handling:
//  - inside a task thread → continue that repo's Claude session
//  - @mention in a normal channel → casual chat (no repo)
bot.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (message.channel.isThread()) {
      await handleThreadMessage(message);
    } else {
      await handleMention(message);
    }
  } catch (err) {
    log.error({ err }, "message handler crashed");
  }
});

// Closing/archiving/deleting a thread tears down its worktree + session.
bot.on(Events.ThreadDelete, (thread) => {
  api.closeThread(thread.id).catch(() => {});
});
bot.on(Events.ThreadUpdate, (oldThread, newThread) => {
  if (!oldThread.archived && newThread.archived) {
    api.closeThread(newThread.id).catch(() => {});
  }
});

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  redis.disconnect();
  await bot.destroy();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

bot.login(cfg.discord.token!).catch((err) => {
  log.error({ err }, "login failed");
  process.exit(1);
});
