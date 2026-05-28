import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, desc } from "drizzle-orm";
import { getDb, tasks, taskLogs } from "@ccb/db";
import { CreateTaskRequest, EVENT_CHANNEL, newTaskId } from "@ccb/shared";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";
import { getRedis, getTaskQueue } from "../queue.js";

export function tasksRouter() {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTaskRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const input = parsed.data;
    const id = newTaskId();

    const [task] = await getDb()
      .insert(tasks)
      .values({
        id,
        repoSlug: input.repoSlug,
        sessionId: input.sessionId ?? null,
        prompt: input.prompt,
        requestedBy: input.requestedBy ?? null,
        channelId: input.channelId ?? null,
        status: "queued",
      })
      .returning();

    await getTaskQueue().add(
      "run",
      {
        taskId: id,
        repoSlug: input.repoSlug,
        prompt: input.prompt,
        sessionId: input.sessionId,
        channelId: input.channelId,
        requestedBy: input.requestedBy,
        baseBranch: input.baseBranch,
        threadId: input.threadId,
        // Per-thread model choice (from /model); undefined → CLI default model.
        model: input.model,
      },
      { jobId: id },
    );

    return c.json({ task }, 201);
  });

  app.get("/", async (c) => {
    const repoSlug = c.req.query("repo");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const q = getDb().select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
    const rows = repoSlug ? await q.where(eq(tasks.repoSlug, repoSlug)) : await q;
    return c.json({ tasks: rows });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const task = rows[0];
    if (!task) throw new NotFoundError("task", id);
    return c.json({ task });
  });

  app.get("/:id/logs", async (c) => {
    const id = c.req.param("id");
    const rows = await getDb()
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.taskId, id))
      .orderBy(taskLogs.at);
    return c.json({ logs: rows });
  });

  app.post("/:id/cancel", async (c) => {
    const id = c.req.param("id");
    // Publish a cancel signal — worker subscribes and aborts the run.
    await getRedis().publish(EVENT_CHANNEL(id) + ".cancel", "1");
    await getDb()
      .update(tasks)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(tasks.id, id));
    return c.json({ ok: true });
  });

  app.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const sub = getRedis().duplicate();
      const channel = EVENT_CHANNEL(id);
      await sub.subscribe(channel);
      const handler = (ch: string, message: string) => {
        if (ch !== channel) return;
        stream.writeSSE({ data: message, event: "message" }).catch(() => {});
      };
      sub.on("message", handler);

      const heartbeat = setInterval(() => {
        stream.writeSSE({ data: "ping", event: "ping" }).catch(() => {});
      }, 15_000);

      c.req.raw.signal.addEventListener("abort", async () => {
        clearInterval(heartbeat);
        sub.off("message", handler);
        await sub.unsubscribe(channel);
        sub.disconnect();
      });

      // Keep the stream open until the client disconnects.
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
  });

  return app;
}
