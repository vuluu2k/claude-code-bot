import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, threads, tasks } from "@ccb/db";
import { EVENT_CHANNEL } from "@ccb/shared";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";
import { RepoRegistry, resetWorktree, summarizeDiff, diffOneLiner } from "@ccb/repo-manager";
import {
  commitAll,
  commitsAhead,
  pushBranch,
  ensurePullRequest,
} from "@ccb/github-tools";
import { getRedis } from "../queue.js";

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

  // Cancel whatever task is currently running in this thread, without the
  // caller needing to know the task id. In a chat-style thread the task id is
  // never shown, so users just say "cancel"/"huỷ" — we resolve the active task
  // here. Thread tasks are created with `channelId === <thread id>` (see the
  // discord-bot's runThreadTask), so that's how we look them up.
  app.post("/:id/cancel", async (c) => {
    const threadId = c.req.param("id");

    // The newest queued-or-running task in this thread is the one to abort.
    // There is normally at most one, but ordering by createdAt keeps us correct
    // if an older task somehow lingers.
    const rows = await getDb()
      .select({ taskId: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.channelId, threadId), inArray(tasks.status, ["queued", "running"])))
      .orderBy(desc(tasks.createdAt))
      .limit(1);

    const taskId = rows[0]?.taskId;
    if (!taskId) {
      // Nothing in flight — report it so the bot can say so instead of erroring.
      return c.json({ ok: false, reason: "no active task" });
    }

    // Same mechanism as POST /tasks/:id/cancel: publish an abort signal the
    // worker is listening for, then mark the row cancelled immediately so the
    // UI reflects it even before the worker finishes tearing the run down.
    await getRedis().publish(EVENT_CHANNEL(taskId) + ".cancel", "1");
    await getDb()
      .update(tasks)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(tasks.id, taskId));

    return c.json({ ok: true, taskId });
  });

  // Most recent task created in this thread (or null). Lets the bot resolve a
  // task for thread-scoped /diff and /status without the user pasting an id.
  app.get("/:id/latest-task", async (c) => {
    const threadId = c.req.param("id");
    const rows = await getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.channelId, threadId))
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    return c.json({ task: rows[0] ?? null });
  });

  // /new — start a fresh conversation while keeping the same worktree + code.
  // We just forget the Claude session id so the next message starts a brand-new
  // Claude session (no --resume) instead of continuing the prior transcript.
  app.post("/:id/new", async (c) => {
    const id = c.req.param("id");
    const [row] = await getDb()
      .update(threads)
      .set({ claudeSessionId: null, status: "active", updatedAt: new Date() })
      .where(eq(threads.id, id))
      .returning();
    if (!row) throw new NotFoundError("thread", id);
    return c.json({ ok: true });
  });

  // /resume — reactivate a thread that was closed/archived so follow-up messages
  // are processed again. The worktree + Claude session id are left intact, so
  // the conversation literally picks up where it left off.
  app.post("/:id/resume", async (c) => {
    const id = c.req.param("id");
    const [row] = await getDb()
      .update(threads)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(threads.id, id))
      .returning();
    if (!row) throw new NotFoundError("thread", id);
    return c.json({ ok: true, resumed: Boolean(row.claudeSessionId) });
  });

  // /rewind — discard ALL changes in the thread's worktree, back to the repo's
  // base branch. Destructive but contained to the disposable per-thread worktree
  // (never the main clone). We capture a summary of what we're about to drop so
  // the bot can tell the user exactly what was undone.
  app.post("/:id/rewind", async (c) => {
    const id = c.req.param("id");
    const rows = await getDb().select().from(threads).where(eq(threads.id, id)).limit(1);
    const thread = rows[0];
    if (!thread) throw new NotFoundError("thread", id);
    if (!thread.worktreePath) {
      throw new ValidationError("thread has no worktree yet — nothing to rewind");
    }

    const repo = await registry.get(thread.repoSlug);
    const baseRef = `origin/${repo.defaultBranch}`;

    // Summarize first (against base) so we can report what gets discarded.
    let discarded = "no changes";
    try {
      discarded = diffOneLiner(await summarizeDiff(thread.worktreePath, baseRef));
    } catch {
      /* best-effort summary only */
    }

    await resetWorktree(thread.worktreePath, baseRef);
    return c.json({ ok: true, discarded });
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
