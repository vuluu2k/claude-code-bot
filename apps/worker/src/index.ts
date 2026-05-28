import { Worker, DelayedError, type Job } from "bullmq";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";
import { TASK_QUEUE, EVENT_CHANNEL } from "@ccb/shared";
import { closeDb } from "@ccb/db";
import { processTask, type TaskJobData } from "./processor.js";
import { closeRedis, getBullConnection, getRedis } from "./queue.js";
import { threadLockKey, tryAcquire, release } from "./lock.js";
import { startCleanupLoop } from "./cleanup.js";

const log = makeLogger("worker");
const cfg = loadConfig();

/**
 * Map of taskId → AbortController. A redis pub/sub channel
 * `ccb.events.<taskId>.cancel` triggers an abort, propagated to the Claude run.
 */
const inflight = new Map<string, AbortController>();

const cancelSub = getRedis().duplicate();
cancelSub.psubscribe("ccb.events.*.cancel", (err) => {
  if (err) log.error({ err }, "failed to subscribe to cancel pattern");
});
cancelSub.on("pmessage", (_pattern, channel) => {
  const m = /^ccb\.events\.(.+)\.cancel$/.exec(channel);
  const taskId = m?.[1];
  if (!taskId) return;
  const ctl = inflight.get(taskId);
  if (ctl) {
    log.warn({ taskId }, "cancellation signal received — aborting");
    ctl.abort();
  }
});

// Lock TTL must outlive the longest possible run so the lock isn't released
// mid-task; the run itself is hard-capped at taskTimeoutMs.
const LOCK_TTL_MS = cfg.worker.taskTimeoutMs + 5 * 60 * 1000;

const worker = new Worker<TaskJobData>(
  TASK_QUEUE,
  async (job: Job<TaskJobData>, token?: string) => {
    // Serialize tasks within a thread: only one may touch the shared worktree
    // at a time. If the thread is busy, requeue this job with a short delay
    // instead of blocking a worker slot.
    let lockToken: string | null = null;
    const lockKey = job.data.threadId ? threadLockKey(job.data.threadId) : null;
    if (lockKey) {
      lockToken = await tryAcquire(lockKey, LOCK_TTL_MS);
      if (!lockToken) {
        log.info({ taskId: job.data.taskId, threadId: job.data.threadId }, "thread busy — requeueing");
        await job.moveToDelayed(Date.now() + 3_000, token);
        throw new DelayedError();
      }
    }

    const ctl = new AbortController();
    inflight.set(job.data.taskId, ctl);
    try {
      await processTask(job.data, { signal: ctl.signal });
    } finally {
      inflight.delete(job.data.taskId);
      if (lockKey && lockToken) await release(lockKey, lockToken).catch(() => {});
    }
  },
  {
    connection: getBullConnection(),
    concurrency: cfg.worker.concurrency,
    lockDuration: Math.min(cfg.worker.taskTimeoutMs, 30 * 60 * 1000),
  },
);

worker.on("ready", () => log.info({ queue: TASK_QUEUE }, "worker ready"));
worker.on("completed", (job) => log.info({ taskId: job.data.taskId }, "job completed"));
worker.on("failed", (job, err) =>
  log.error({ taskId: job?.data.taskId, err }, "job failed"),
);
worker.on("error", (err) => log.error({ err }, "worker error"));

const stopCleanup = startCleanupLoop();

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  stopCleanup();
  // Abort all inflight runs cleanly.
  for (const [id, ctl] of inflight) {
    log.warn({ taskId: id }, "aborting inflight task on shutdown");
    ctl.abort();
  }
  await worker.close();
  cancelSub.disconnect();
  await closeRedis();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Suppress unused-var TS warning while keeping the import for side effects.
void EVENT_CHANNEL;
