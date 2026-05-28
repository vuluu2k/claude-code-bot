import path from "node:path";
import { promises as fs } from "node:fs";
import { makeLogger } from "@ccb/shared/logger";
import { newWorktreeBranch } from "@ccb/shared/ids";
import { ValidationError } from "@ccb/shared/errors";
import {
  createWorktree,
  fetchAll,
  getDefaultBranch,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "./git.js";
import { RepoRegistry } from "./registry.js";

const log = makeLogger("worktree");

export interface Worktree {
  taskId: string;
  repoSlug: string;
  path: string;
  branch: string;
  baseBranch: string;
}

/**
 * Worktree manager — creates throwaway, isolated git worktrees per task so
 * concurrent Claude runs never collide and the main clone stays clean.
 */
export class WorktreeManager {
  constructor(private readonly registry: RepoRegistry) {}

  async create(opts: {
    repoSlug: string;
    taskId: string;
    baseBranch?: string;
  }): Promise<Worktree> {
    const repoPath = this.registry.repoPath(opts.repoSlug);
    await fetchAll(repoPath);

    const baseBranch =
      opts.baseBranch?.trim() || (await getDefaultBranch(repoPath));
    if (!/^[a-zA-Z0-9._\/\-]+$/.test(baseBranch)) {
      throw new ValidationError(`invalid base branch: ${baseBranch}`);
    }

    const worktreeRoot = this.registry.worktreeRoot(opts.repoSlug);
    await fs.mkdir(worktreeRoot, { recursive: true });

    const branch = newWorktreeBranch();
    const wtPath = path.join(worktreeRoot, opts.taskId);

    // The base ref must be reachable — prefer origin/<branch> after fetch.
    const baseRef = `origin/${baseBranch}`;

    log.info({ repoSlug: opts.repoSlug, taskId: opts.taskId, branch, baseRef }, "creating worktree");
    await createWorktree({
      repoPath,
      worktreePath: wtPath,
      branch,
      baseBranch: baseRef,
    });

    return { taskId: opts.taskId, repoSlug: opts.repoSlug, path: wtPath, branch, baseBranch };
  }

  /**
   * Reuse a persistent worktree keyed by an arbitrary id (e.g. a Discord thread
   * id) so multiple tasks edit the same checkout. Creates it on first call,
   * returns the existing one afterwards. Used by thread-as-session mode.
   */
  async getOrCreate(opts: {
    repoSlug: string;
    key: string;
    baseBranch?: string;
  }): Promise<Worktree> {
    const safeKey = opts.key.replace(/[^a-zA-Z0-9_-]/g, "_");
    const worktreeRoot = this.registry.worktreeRoot(opts.repoSlug);
    const wtPath = path.join(worktreeRoot, safeKey);

    // Already checked out + registered with git? Reuse it.
    const existing = await fs
      .stat(path.join(wtPath, ".git"))
      .then(() => true)
      .catch(() => false);

    if (existing) {
      const repoPath = this.registry.repoPath(opts.repoSlug);
      const wts = await listWorktrees(repoPath);
      const match = wts.find((w) => path.resolve(w.path) === path.resolve(wtPath));
      const baseBranch = opts.baseBranch?.trim() || (await getDefaultBranch(repoPath));
      log.info({ repoSlug: opts.repoSlug, key: safeKey, path: wtPath }, "reusing worktree");
      return {
        taskId: safeKey,
        repoSlug: opts.repoSlug,
        path: wtPath,
        branch: match?.branch || `ccb/${safeKey}`,
        baseBranch,
      };
    }

    const repoPath = this.registry.repoPath(opts.repoSlug);
    await fetchAll(repoPath);
    const baseBranch = opts.baseBranch?.trim() || (await getDefaultBranch(repoPath));
    if (!/^[a-zA-Z0-9._\/\-]+$/.test(baseBranch)) {
      throw new ValidationError(`invalid base branch: ${baseBranch}`);
    }
    await fs.mkdir(worktreeRoot, { recursive: true });
    const branch = `ccb/${safeKey}`;
    const baseRef = `origin/${baseBranch}`;
    log.info({ repoSlug: opts.repoSlug, key: safeKey, branch, baseRef }, "creating persistent worktree");
    await createWorktree({ repoPath, worktreePath: wtPath, branch, baseBranch: baseRef });
    return { taskId: safeKey, repoSlug: opts.repoSlug, path: wtPath, branch, baseBranch };
  }

  async remove(repoSlug: string, worktreePath: string) {
    const repoPath = this.registry.repoPath(repoSlug);
    log.info({ repoSlug, worktreePath }, "removing worktree");
    await removeWorktree(repoPath, worktreePath);
    await pruneWorktrees(repoPath);
    await fs.rm(worktreePath, { recursive: true, force: true });
  }

  async list(repoSlug: string) {
    return listWorktrees(this.registry.repoPath(repoSlug));
  }

  /**
   * Drop worktrees older than `maxAgeMs`, skipping any path in `protect`
   * (e.g. worktrees of still-active threads). Returns the count removed.
   */
  async cleanupStale(
    repoSlug: string,
    maxAgeMs: number,
    protect: Set<string> = new Set(),
  ): Promise<number> {
    const worktreeRoot = this.registry.worktreeRoot(repoSlug);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(worktreeRoot);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of entries) {
      const p = path.join(worktreeRoot, name);
      if (protect.has(path.resolve(p))) continue;
      const stat = await fs.stat(p).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await this.remove(repoSlug, p).catch((e) =>
          log.warn({ err: e, path: p }, "failed to remove stale worktree"),
        );
        removed++;
      }
    }
    return removed;
  }
}
