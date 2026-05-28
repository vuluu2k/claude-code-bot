import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";

const log = makeLogger("memory-system");

export interface RecentTask {
  id: string;
  prompt: string;
  status: string;
  diffSummary?: string;
  at: string;
}

export interface RepoMemory {
  slug: string;
  summary: string;
  architecture: string;
  recentTasks: RecentTask[];
  knownIssues: string[];
}

/**
 * File-backed memory per repository. Stored alongside the workspace as plain
 * markdown + JSON so it can be inspected, edited, and version-controlled.
 *
 *   memory/<slug>/summary.md
 *   memory/<slug>/architecture.md
 *   memory/<slug>/recent-tasks.json
 *   memory/<slug>/known-issues.md
 */
export class MemoryStore {
  private readonly root: string;

  constructor(root?: string) {
    const cfg = loadConfig();
    this.root = root ?? path.join(cfg.workspace.root, "memory");
  }

  private repoDir(slug: string) {
    return path.join(this.root, slug);
  }

  private async readFile(p: string, fallback = ""): Promise<string> {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return fallback;
    }
  }

  async load(slug: string): Promise<RepoMemory> {
    const dir = this.repoDir(slug);
    const [summary, architecture, knownIssues, recentRaw] = await Promise.all([
      this.readFile(path.join(dir, "summary.md")),
      this.readFile(path.join(dir, "architecture.md")),
      this.readFile(path.join(dir, "known-issues.md")),
      this.readFile(path.join(dir, "recent-tasks.json"), "[]"),
    ]);

    let recentTasks: RecentTask[] = [];
    try {
      recentTasks = JSON.parse(recentRaw);
    } catch (err) {
      log.warn({ slug, err }, "failed to parse recent-tasks.json — resetting");
    }

    const issues = knownIssues
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);

    return {
      slug,
      summary: summary.trim(),
      architecture: architecture.trim(),
      knownIssues: issues,
      recentTasks,
    };
  }

  async save(slug: string, mem: Partial<Omit<RepoMemory, "slug">>): Promise<void> {
    const dir = this.repoDir(slug);
    await fs.mkdir(dir, { recursive: true });
    const ops: Promise<unknown>[] = [];
    if (mem.summary !== undefined) {
      ops.push(fs.writeFile(path.join(dir, "summary.md"), mem.summary.trim() + "\n"));
    }
    if (mem.architecture !== undefined) {
      ops.push(
        fs.writeFile(path.join(dir, "architecture.md"), mem.architecture.trim() + "\n"),
      );
    }
    if (mem.recentTasks !== undefined) {
      ops.push(
        fs.writeFile(path.join(dir, "recent-tasks.json"), JSON.stringify(mem.recentTasks, null, 2)),
      );
    }
    if (mem.knownIssues !== undefined) {
      const md = mem.knownIssues.map((i) => `- ${i}`).join("\n");
      ops.push(fs.writeFile(path.join(dir, "known-issues.md"), md + "\n"));
    }
    await Promise.all(ops);
  }

  async recordTask(slug: string, task: RecentTask, keep = 20): Promise<void> {
    const mem = await this.load(slug);
    const updated = [task, ...mem.recentTasks.filter((t) => t.id !== task.id)].slice(0, keep);
    await this.save(slug, { recentTasks: updated });
  }
}
