import { z } from "zod";

export const TaskStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const CreateTaskRequest = z.object({
  repoSlug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase slug only"),
  prompt: z.string().min(1).max(8000),
  sessionId: z.string().optional(),
  /** Discord user invoking the task — for audit + permissions. */
  requestedBy: z.string().optional(),
  /** Discord channel for streaming updates back. */
  channelId: z.string().optional(),
  /** Optional source branch to base the worktree on. */
  baseBranch: z.string().optional(),
  /**
   * Discord thread id. When set, the task joins that thread's persistent
   * worktree + Claude session (thread-as-session mode) instead of a fresh,
   * throwaway worktree.
   */
  threadId: z.string().optional(),
  /**
   * Claude model alias to run this task with (e.g. "opus", "sonnet", "haiku").
   * Forwarded to the CLI as `--model`. Omit to use the CLI's default model.
   * Per-thread selection is chosen via the bot's /model command.
   */
  model: z.string().max(40).optional(),
  /**
   * URLs of files the user attached in Discord (any type). The worker downloads
   * them into the worktree so Claude can open them with its Read tool.
   */
  attachments: z.array(z.string().url()).max(10).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const Repo = z.object({
  slug: z.string(),
  remoteUrl: z.string(),
  defaultBranch: z.string().default("main"),
  description: z.string().optional(),
});
export type Repo = z.infer<typeof Repo>;

export const TaskRecord = z.object({
  id: z.string(),
  repoSlug: z.string(),
  sessionId: z.string().optional(),
  status: TaskStatus,
  prompt: z.string(),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  requestedBy: z.string().optional(),
  channelId: z.string().optional(),
  diffSummary: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

export const StreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdout"), taskId: z.string(), data: z.string(), at: z.number() }),
  z.object({ type: z.literal("stderr"), taskId: z.string(), data: z.string(), at: z.number() }),
  z.object({
    type: z.literal("status"),
    taskId: z.string(),
    status: TaskStatus,
    at: z.number(),
  }),
  z.object({
    type: z.literal("diff"),
    taskId: z.string(),
    summary: z.string(),
    at: z.number(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

export const TASK_QUEUE = "ccb.tasks";
export const EVENT_CHANNEL = (taskId: string) => `ccb.events.${taskId}`;
