import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, threads } from "@ccb/db";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";
import { RepoRegistry } from "@ccb/repo-manager";
import {
  commitAll,
  commitsAhead,
  pushBranch,
  ensurePullRequest,
} from "@ccb/github-tools";

const RegisterThread = z.object({
  id: z.string().min(1), // discord thread id
  repoSlug: z.string().min(1),
  channelId: z.string().optional(),
  createdBy: z.string().optional(),
});

export function threadsRouter() {
  const app = new Hono();
  const registry = new RepoRegistry();

  // Register (or upsert) a Discord thread ↔ repo binding.
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = RegisterThread.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    }
    // Ensure the repo exists before binding a thread to it.
    await registry.get(parsed.data.repoSlug);

    const [row] = await getDb()
      .insert(threads)
      .values({
        id: parsed.data.id,
        repoSlug: parsed.data.repoSlug,
        channelId: parsed.data.channelId ?? null,
        createdBy: parsed.data.createdBy ?? null,
        status: "active",
      })
      .onConflictDoUpdate({
        target: threads.id,
        set: {
          repoSlug: parsed.data.repoSlug,
          channelId: parsed.data.channelId ?? null,
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();
    return c.json({ thread: row }, 201);
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await getDb().select().from(threads).where(eq(threads.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundError("thread", id);
    return c.json({ thread: rows[0] });
  });

  app.post("/:id/close", async (c) => {
    const id = c.req.param("id");
    await getDb()
      .update(threads)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(threads.id, id));
    return c.json({ ok: true });
  });

  // User-triggered: commit leftovers, push the thread's branch, open/update a PR.
  app.post("/:id/pr", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title : "";

    const rows = await getDb().select().from(threads).where(eq(threads.id, id)).limit(1);
    const thread = rows[0];
    if (!thread) throw new NotFoundError("thread", id);
    if (!thread.worktreePath || !thread.branch) {
      throw new ValidationError("thread has no worktree yet — run a task first");
    }

    const repo = await registry.get(thread.repoSlug);
    const base = repo.defaultBranch;
    const cwd = thread.worktreePath;

    await commitAll(cwd, title || "chore: changes via /pr");
    const ahead = await commitsAhead(cwd, `origin/${base}`);
    if (ahead === 0) {
      return c.json({ pr: null, reason: "no changes to open a PR for" });
    }
    await pushBranch(cwd, thread.branch);
    const url = await ensurePullRequest({
      cwd,
      branch: thread.branch,
      base,
      title: title || `Changes from ${thread.repoSlug} thread`,
      body: `Opened from Discord via /pr (thread ${id}).`,
    });
    return c.json({ pr: url });
  });

  return app;
}
