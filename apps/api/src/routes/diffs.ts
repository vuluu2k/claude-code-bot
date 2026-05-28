import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, tasks } from "@ccb/db";
import { summarizeDiff } from "@ccb/repo-manager";
import { NotFoundError } from "@ccb/shared/errors";

export function diffsRouter() {
  const app = new Hono();

  app.get("/:taskId", async (c) => {
    const id = c.req.param("taskId");
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const task = rows[0];
    if (!task) throw new NotFoundError("task", id);
    if (!task.worktreePath) {
      return c.json({ diff: null, reason: "worktree not initialized" });
    }
    const summary = await summarizeDiff(task.worktreePath);
    return c.json({ diff: summary });
  });

  return app;
}
