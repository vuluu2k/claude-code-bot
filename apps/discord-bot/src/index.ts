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

  let buffer = "";
  let lastFlush = Date.now();
  const flush = async () => {
    if (!buffer.trim()) return;
    const out = buffer;
    buffer = "";
    for (const part of chunk(codeBlock(out.slice(-1900)))) {
      await channel.send(part).catch(() => {});
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
    if (ev.type === "stdout" || ev.type === "stderr") {
      buffer += ev.data;
      if (buffer.length > 1_500) {
        lastFlush = Date.now();
        await flush();
      }
    } else if (ev.type === "status") {
      await flush();
      if (["succeeded", "failed", "cancelled", "timeout"].includes(ev.status)) {
        clearInterval(flushTimer);
        sub.unsubscribe(eventChannel).catch(() => {});
        sub.disconnect();
        if (reactTarget) await setStatus(reactTarget, statusEmojiForTask[ev.status] ?? "🎉");
        await channel.send(`Task \`${taskId}\` → **${ev.status}**`).catch(() => {});
        try {
          const { diff } = await api.getDiff(taskId);
          if (diff?.hasChanges) {
            await channel.send(
              `Diff: ${diff.totalFiles} file(s), +${diff.insertions}/-${diff.deletions}\n` +
                codeBlock(diff.preview.slice(0, 1700), "diff"),
            );
          } else {
            await channel.send("No file changes. Type another message to continue.");
          }
        } catch (e) {
          log.warn({ err: e, taskId }, "diff fetch failed");
        }
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

  await setStatus(message, RUNNING_EMOJI);
  await message.channel.sendTyping().catch(() => {});
  await runThreadTask(message.channel as AnyThreadChannel, {
    repoSlug: thread.repoSlug,
    prompt: content,
    requestedBy: message.author.id,
    reactTarget: message,
  });
}

const CHAT_TIMEOUT_MS = 180_000;
// How many recent channel messages to feed Claude as context (env-tunable).
const CHAT_CONTEXT_MESSAGES = Math.max(
  0,
  Math.min(Number(process.env.CHAT_CONTEXT_MESSAGES ?? 15), 50),
);

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
    "Bạn là một trợ lý thân thiện trong một kênh chat Discord.",
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
  const args = ["--print", "--dangerously-skip-permissions", prompt];

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

async function handleStatus(i: ChatInputCommandInteraction) {
  const id = i.options.getString("task_id", true);
  await i.deferReply({ ephemeral: true });
  try {
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
  const id = i.options.getString("task_id", true);
  await i.deferReply({ ephemeral: true });
  try {
    const { diff } = await api.getDiff(id);
    if (!diff) {
      await i.editReply("No diff available (worktree not initialized).");
      return;
    }
    if (!diff.hasChanges) {
      await i.editReply("No changes.");
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

async function handleCancel(i: ChatInputCommandInteraction) {
  const id = i.options.getString("task_id", true);
  await i.deferReply({ ephemeral: true });
  try {
    await api.cancelTask(id);
    await i.editReply(`Cancellation signal sent for \`${id}\`.`);
  } catch (err) {
    await i.editReply(`Failed: ${(err as Error).message}`);
  }
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
