import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";
import {
  isCcbError,
  NotFoundError,
  ValidationError,
  PermissionError,
  ShellError,
} from "@ccb/shared/errors";
import { reposRouter } from "./routes/repos.js";
import { tasksRouter } from "./routes/tasks.js";
import { diffsRouter } from "./routes/diffs.js";
import { sessionsRouter } from "./routes/sessions.js";
import { threadsRouter } from "./routes/threads.js";
import { closeQueue } from "./queue.js";
import { closeDb, runMigrations } from "@ccb/db";

const log = makeLogger("api");
const cfg = loadConfig();

// Auto-apply DB migrations on boot unless explicitly disabled. The API waits
// for Postgres to be healthy (compose depends_on), so this is the natural place
// to bootstrap the schema without a manual step.
if (process.env.AUTO_MIGRATE !== "false") {
  try {
    await runMigrations(cfg.databaseUrl);
    log.info("migrations applied");
  } catch (err) {
    log.error({ err }, "migration failed — exiting");
    process.exit(1);
  }
}

const app = new Hono();
app.use("*", honoLogger((msg) => log.info(msg)));
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "ccb-api" }));
app.get("/", (c) => c.text("Claude Code Bot API\n"));

app.route("/repos", reposRouter());
app.route("/tasks", tasksRouter());
app.route("/diffs", diffsRouter());
app.route("/sessions", sessionsRouter());
app.route("/threads", threadsRouter());

// Scrub any leaked token from git output before returning it to clients.
function redact(s: string): string {
  return s.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message, code: err.code }, 400);
  if (err instanceof NotFoundError) return c.json({ error: err.message, code: err.code }, 404);
  if (err instanceof PermissionError) return c.json({ error: err.message, code: err.code }, 403);
  if (err instanceof ShellError) {
    // Surface the real reason (git/gh stderr tail) instead of just the exit code.
    const detail = redact((err.stderr || err.stdout || "").trim()).slice(-600);
    log.error({ err, stderr: err.stderr }, "shell error");
    return c.json(
      { error: err.message, code: err.code, detail: detail || undefined },
      500,
    );
  }
  if (isCcbError(err)) {
    log.error({ err }, "ccb error");
    return c.json({ error: err.message, code: err.code }, 500);
  }
  log.error({ err }, "unhandled error");
  return c.json({ error: "internal error" }, 500);
});

const server = Bun.serve({
  port: cfg.api.port,
  fetch: app.fetch,
});

log.info({ port: server.port, baseUrl: cfg.api.baseUrl }, "api listening");

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  server.stop();
  await closeQueue();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export type AppType = typeof app;
