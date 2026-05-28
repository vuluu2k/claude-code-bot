import { SlashCommandBuilder } from "discord.js";

/**
 * Slash command schema. Mirrors the API surface exposed by apps/api.
 * Register with `bun run register` (see register-commands.ts).
 */
export const commands = [
  new SlashCommandBuilder()
    .setName("repos")
    .setDescription("List configured repositories")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Run an AI task on a repository")
    .addStringOption((o) =>
      o.setName("repo").setDescription("Repository slug").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName("task").setDescription("What should Claude do?").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("base").setDescription("Base branch (optional)").setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("status")
    // task_id optional: inside a thread we resolve the thread's latest task.
    .setDescription("Show task status (omit id inside a thread)")
    .addStringOption((o) =>
      o.setName("task_id").setDescription("Task ID (optional inside a thread)").setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("diff")
    // task_id optional: inside a thread we show that thread's current changes.
    .setDescription("Show code changes (omit id inside a thread)")
    .addStringOption((o) =>
      o.setName("task_id").setDescription("Task ID (optional inside a thread)").setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("Tail recent logs for a task")
    .addStringOption((o) =>
      o.setName("task_id").setDescription("Task ID").setRequired(true),
    )
    .addIntegerOption((o) =>
      o.setName("limit").setDescription("Max lines").setMinValue(10).setMaxValue(500),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("session")
    .setDescription("Manage AI sessions for a repository")
    .addSubcommand((s) =>
      s
        .setName("new")
        .setDescription("Start a new session")
        .addStringOption((o) =>
          o.setName("repo").setDescription("Repository slug").setRequired(true),
        )
        .addStringOption((o) => o.setName("title").setDescription("Session title")),
    )
    .addSubcommand((s) =>
      s
        .setName("list")
        .setDescription("List sessions")
        .addStringOption((o) => o.setName("repo").setDescription("Filter by repo")),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("register-repo")
    .setDescription("Register a new repository (admin)")
    .addStringOption((o) => o.setName("slug").setDescription("Short name").setRequired(true))
    .addStringOption((o) => o.setName("url").setDescription("Git remote URL").setRequired(true))
    .addStringOption((o) => o.setName("branch").setDescription("Default branch"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("cancel")
    // Inside a thread you can omit task_id — the running task is resolved from
    // the thread. The id is only needed to cancel a task from elsewhere.
    .setDescription("Cancel a running task (omit id inside a thread)")
    .addStringOption((o) =>
      o
        .setName("task_id")
        .setDescription("Task ID (optional inside a thread)")
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("pr")
    .setDescription("Push this thread's branch and open a pull request")
    .addStringOption((o) =>
      o.setName("title").setDescription("PR title (optional)").setRequired(false),
    )
    .toJSON(),

  // ── Claude Code-style conversation controls (use inside a /repo thread) ──

  // /model — pick which Claude model this thread runs with. The choice is kept
  // in the bot per-thread and passed to the CLI as --model on the next message.
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Choose the Claude model for this thread")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("Model to use")
        .setRequired(true)
        .addChoices(
          { name: "Opus (mạnh nhất)", value: "opus" },
          { name: "Sonnet (cân bằng)", value: "sonnet" },
          { name: "Haiku (nhanh/rẻ)", value: "haiku" },
          { name: "Default (mặc định của CLI)", value: "default" },
        ),
    )
    .toJSON(),

  // /new — start a fresh conversation in this thread (keeps the code/worktree).
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a fresh conversation in this thread (keeps the code)")
    .toJSON(),

  // /resume — reactivate this thread if it was closed/archived, and keep chatting.
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume this thread's conversation")
    .toJSON(),

  // /rewind — discard ALL changes in this thread's worktree, back to base.
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Discard all changes in this thread (reset to base branch)")
    .toJSON(),

  // /end — close this thread and free its worktree.
  new SlashCommandBuilder()
    .setName("end")
    .setDescription("Close this thread and clean up its worktree")
    .toJSON(),

  // /tasks — list recent tasks, optionally filtered by repo.
  new SlashCommandBuilder()
    .setName("tasks")
    .setDescription("List recent tasks")
    .addStringOption((o) => o.setName("repo").setDescription("Filter by repo").setRequired(false))
    .toJSON(),

  // /help — show what the bot can do and how threads work.
  new SlashCommandBuilder().setName("help").setDescription("How to use the bot").toJSON(),
];
