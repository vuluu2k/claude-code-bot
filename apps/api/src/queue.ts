import { Queue, QueueEvents, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { loadConfig } from "@ccb/shared/config";
import { TASK_QUEUE } from "@ccb/shared";

export interface TaskJobData {
  taskId: string;
  repoSlug: string;
  prompt: string;
  sessionId?: string;
  channelId?: string;
  requestedBy?: string;
  baseBranch?: string;
  threadId?: string;
  /** Claude model alias to run with (e.g. "opus"); undefined → CLI default. */
  model?: string;
  /** URLs of Discord attachments to download into the worktree for Claude. */
  attachments?: string[];
}

let _connection: IORedis | null = null;
let _queue: Queue<TaskJobData> | null = null;
let _events: QueueEvents | null = null;

/** Plain ioredis instance for ad-hoc pub/sub. */
export function getRedis(): IORedis {
  if (_connection) return _connection;
  const cfg = loadConfig();
  _connection = new IORedis(cfg.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return _connection;
}

/**
 * BullMQ bundles its own ioredis version so we hand it a config object — that
 * dodges the dual-package-hazard between top-level `ioredis` and the one
 * nested inside `bullmq`.
 */
function bullConnection(): ConnectionOptions {
  const url = loadConfig().redisUrl;
  return { url } as ConnectionOptions;
}

export function getTaskQueue(): Queue<TaskJobData> {
  if (_queue) return _queue;
  const q = new Queue<TaskJobData>(TASK_QUEUE, {
    connection: bullConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 200, age: 60 * 60 * 24 },
      removeOnFail: { count: 200, age: 60 * 60 * 24 * 7 },
    },
  });
  _queue = q;
  return q;
}

export function getTaskEvents(): QueueEvents {
  if (_events) return _events;
  _events = new QueueEvents(TASK_QUEUE, { connection: bullConnection() });
  return _events;
}

export async function closeQueue() {
  await Promise.all([_queue?.close(), _events?.close()]);
  _queue = null;
  _events = null;
  if (_connection) {
    _connection.disconnect();
    _connection = null;
  }
}
