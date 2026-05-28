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
    .setDescription("Show status of a task")
    .addStringOption((o) =>
      o.setName("task_id").setDescription("Task ID").setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("diff")
    .setDescription("Show diff summary for a task")
    .addStringOption((o) =>
      o.setName("task_id").setDescription("Task ID").setRequired(true),
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
    .setDescription("Cancel a running task")
    .addStringOption((o) =>
      o.setName("task_id").setDescription("Task ID").setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("pr")
    .setDescription("Push this thread's branch and open a pull request")
    .addStringOption((o) =>
      o.setName("title").setDescription("PR title (optional)").setRequired(false),
    )
    .toJSON(),
];
