import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
]);

export const repos = pgTable(
  "repos",
  {
    slug: text("slug").primaryKey(),
    remoteUrl: text("remote_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    remoteIdx: uniqueIndex("repos_remote_url_idx").on(t.remoteUrl),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repos.slug, { onDelete: "cascade" }),
    title: text("title"),
    summary: text("summary"),
    /**
     * The latest Claude CLI session id this conversation belongs to. Captured
     * from stream-json output. Passed back via `--resume` on the next task so
     * Claude keeps its in-context memory across multiple tasks.
     */
    claudeSessionId: text("claude_session_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoIdx: index("sessions_repo_idx").on(t.repoSlug),
  }),
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repos.slug, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    status: taskStatusEnum("status").notNull().default("queued"),
    prompt: text("prompt").notNull(),
    requestedBy: text("requested_by"),
    channelId: text("channel_id"),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    diffSummary: text("diff_summary"),
    exitCode: integer("exit_code"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoIdx: index("tasks_repo_idx").on(t.repoSlug),
    statusIdx: index("tasks_status_idx").on(t.status),
    createdIdx: index("tasks_created_idx").on(t.createdAt),
  }),
);

export const taskLogs = pgTable(
  "task_logs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stream: text("stream").notNull(), // "stdout" | "stderr" | "system"
    chunk: text("chunk").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index("task_logs_task_idx").on(t.taskId, t.at),
  }),
);

/**
 * A Discord thread bound to a long-lived Claude conversation. One thread =
 * one persistent worktree + one resumable Claude session. Follow-up messages
 * in the thread continue the same conversation, terminal-style.
 */
export const threads = pgTable(
  "threads",
  {
    // Discord thread id is the natural primary key.
    id: text("id").primaryKey(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repos.slug, { onDelete: "cascade" }),
    channelId: text("channel_id"),
    createdBy: text("created_by"),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    // Latest Claude CLI session id — passed via --resume on the next message.
    claudeSessionId: text("claude_session_id"),
    status: text("status").notNull().default("active"), // active | closed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoIdx: index("threads_repo_idx").on(t.repoSlug),
    statusIdx: index("threads_status_idx").on(t.status),
  }),
);

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskLog = typeof taskLogs.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
