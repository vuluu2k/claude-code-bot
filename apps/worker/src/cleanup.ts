import path from "node:path";
import { and, eq, lt } from "drizzle-orm";
import { getDb, repos, threads } from "@ccb/db";
import { RepoRegistry, WorktreeManager } from "@ccb/repo-manager";
import { makeLogger } from "@ccb/shared/logger";

const log = makeLogger("worker.cleanup");

const registry = new RepoRegistry();
const worktrees = new WorktreeManager(registry);

interface CleanupConfig {
  /** Remove one-off task worktrees older than this (ms). */
  oneOffTtlMs: number;
  /** Close threads idle longer than this (ms) and drop their worktrees. */
  threadIdleTtlMs: number;
  /** How often the loop runs (ms). */
  intervalMs: number;
}

function loadCleanupConfig(): CleanupConfig {
  return {
    oneOffTtlMs: Number(process.env.WORKTREE_TTL_MS ?? 24 * 60 * 60 * 1000),
    threadIdleTtlMs: Number(process.env.THREAD_IDLE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
    intervalMs: Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000),
  };
}

async function tick(cfg: CleanupConfig): Promise<void> {
  // 1. Close threads idle beyond the TTL and remove their worktrees.
  const idleCutoff = new Date(Date.now() - cfg.threadIdleTtlMs);
  const idleThreads = await getDb()
    .select()
    .from(threads)
    .where(and(eq(threads.status, "active"), lt(threads.updatedAt, idleCutoff)));

  for (const t of idleThreads) {
    if (t.worktreePath) {
      await worktrees
        .remove(t.repoSlug, t.worktreePath)
        .catch((e) => log.warn({ err: e, threadId: t.id }, "remove idle thread worktree failed"));
    }
    await getDb()
      .update(threads)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(threads.id, t.id));
    log.info({ threadId: t.id, repo: t.repoSlug }, "closed idle thread");
  }

  // 2. Build the protected set: worktrees of all still-active threads.
  const activeThreads = await getDb()
    .select({ repoSlug: threads.repoSlug, worktreePath: threads.worktreePath })
    .from(threads)
    .where(eq(threads.status, "active"));
  const protect = new Set(
    activeThreads
      .map((t) => t.worktreePath)
      .filter((p): p is string => Boolean(p))
      .map((p) => path.resolve(p)),
  );

  // 3. Prune stale one-off worktrees per repo, skipping protected paths.
  const allRepos = await getDb().select({ slug: repos.slug }).from(repos);
  for (const r of allRepos) {
    const removed = await worktrees
      .cleanupStale(r.slug, cfg.oneOffTtlMs, protect)
      .catch((e) => {
        log.warn({ err: e, repo: r.slug }, "cleanupStale failed");
        return 0;
      });
    if (removed) log.info({ repo: r.slug, removed }, "pruned stale worktrees");
  }
}

/** Start the periodic cleanup loop. Returns a stop function. */
export function startCleanupLoop(): () => void {
  const cfg = loadCleanupConfig();
  log.info(cfg, "starting cleanup loop");
  const timer = setInterval(() => {
    tick(cfg).catch((e) => log.warn({ err: e }, "cleanup tick failed"));
  }, cfg.intervalMs);
  timer.unref();
  // Kick once shortly after boot (not immediately — let the worker settle).
  setTimeout(() => tick(cfg).catch(() => {}), 30_000).unref();
  return () => clearInterval(timer);
}
