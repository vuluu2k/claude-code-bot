import { Hono } from "hono";
import { z } from "zod";
import { RepoRegistry } from "@ccb/repo-manager";
import { NotFoundError, ValidationError } from "@ccb/shared/errors";

const RegisterInput = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
  remoteUrl: z.string().url(),
  defaultBranch: z.string().optional(),
  description: z.string().max(500).optional(),
});

export function reposRouter() {
  const app = new Hono();
  const registry = new RepoRegistry();

  app.get("/", async (c) => {
    const list = await registry.list();
    return c.json({ repos: list });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = RegisterInput.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const repo = await registry.register(parsed.data);
    return c.json({ repo }, 201);
  });

  app.get("/:slug", async (c) => {
    const repo = await registry.get(c.req.param("slug"));
    return c.json({ repo });
  });

  app.delete("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const repo = await registry.get(slug).catch((e) => {
      if (e instanceof NotFoundError) return null;
      throw e;
    });
    if (!repo) return c.json({ ok: true });
    const deleteFiles = c.req.query("files") === "true";
    await registry.remove(slug, { deleteFiles });
    return c.json({ ok: true });
  });

  return app;
}
