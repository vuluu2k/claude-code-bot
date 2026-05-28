import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, threads } from "@ccb/db";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";
import { RepoRegistry } from "@ccb/repo-manager";

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

  return app;
}
