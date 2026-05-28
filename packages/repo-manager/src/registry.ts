import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, repos, type Repo } from "@ccb/db";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";
import { clone, fetchAll, getDefaultBranch } from "./git.js";

const log = makeLogger("repo-registry");

const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/;

export interface RegisterRepoInput {
  slug: string;
  remoteUrl: string;
  defaultBranch?: string;
  description?: string;
}

export class RepoRegistry {
  constructor(private readonly workspaceRoot = loadConfig().workspace.root) {}

  /** Absolute path to the main clone for `slug`. */
  repoPath(slug: string) {
    if (!SLUG_RE.test(slug)) throw new ValidationError(`invalid repo slug: ${slug}`);
    return path.join(this.workspaceRoot, "repos", slug);
  }

  /** Absolute path to the worktree root for `slug`. */
  worktreeRoot(slug: string) {
    return path.join(this.workspaceRoot, "worktrees", slug);
  }

  async list(): Promise<Repo[]> {
    return getDb().select().from(repos).orderBy(repos.slug);
  }

  async get(slug: string): Promise<Repo> {
    const rows = await getDb().select().from(repos).where(eq(repos.slug, slug)).limit(1);
    const r = rows[0];
    if (!r) throw new NotFoundError("repo", slug);
    return r;
  }

  async register(input: RegisterRepoInput): Promise<Repo> {
    if (!SLUG_RE.test(input.slug)) {
      throw new ValidationError(`invalid repo slug: ${input.slug}`);
    }
    const dest = this.repoPath(input.slug);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    // If a clone already exists, skip clone but still upsert metadata.
    const exists = await fs
      .stat(path.join(dest, ".git"))
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      log.info({ slug: input.slug, dest }, "cloning repository");
      await clone(input.remoteUrl, dest, { branch: input.defaultBranch });
    } else {
      log.info({ slug: input.slug, dest }, "repository already cloned, fetching");
      await fetchAll(dest);
    }

    const detected = input.defaultBranch ?? (await getDefaultBranch(dest));

    const [row] = await getDb()
      .insert(repos)
      .values({
        slug: input.slug,
        remoteUrl: input.remoteUrl,
        defaultBranch: detected,
        description: input.description ?? null,
      })
      .onConflictDoUpdate({
        target: repos.slug,
        set: {
          remoteUrl: input.remoteUrl,
          defaultBranch: detected,
          description: input.description ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    return row!;
  }

  async ensureFresh(slug: string): Promise<Repo> {
    const r = await this.get(slug);
    await fetchAll(this.repoPath(slug));
    return r;
  }

  async remove(slug: string, opts: { deleteFiles?: boolean } = {}): Promise<void> {
    await getDb().delete(repos).where(eq(repos.slug, slug));
    if (opts.deleteFiles) {
      await fs.rm(this.repoPath(slug), { recursive: true, force: true });
      await fs.rm(this.worktreeRoot(slug), { recursive: true, force: true });
    }
  }
}
