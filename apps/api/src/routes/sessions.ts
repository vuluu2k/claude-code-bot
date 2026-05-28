import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, sessions } from "@ccb/db";
import { newSessionId } from "@ccb/shared/ids";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";

const CreateSession = z.object({
  repoSlug: z.string().min(1),
  title: z.string().max(200).optional(),
  summary: z.string().max(4_000).optional(),
});

export function sessionsRouter() {
  const app = new Hono();

  app.get("/", async (c) => {
    const repoSlug = c.req.query("repo");
    const q = getDb().select().from(sessions).orderBy(desc(sessions.updatedAt));
    const rows = repoSlug ? await q.where(eq(sessions.repoSlug, repoSlug)) : await q;
    return c.json({ sessions: rows });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateSession.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const id = newSessionId();
    const [row] = await getDb()
      .insert(sessions)
      .values({
        id,
        repoSlug: parsed.data.repoSlug,
        title: parsed.data.title ?? null,
        summary: parsed.data.summary ?? null,
      })
      .returning();
    return c.json({ session: row }, 201);
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await getDb().select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundError("session", id);
    return c.json({ session: rows[0] });
  });

  return app;
}
