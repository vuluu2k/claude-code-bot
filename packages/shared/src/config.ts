import { z } from "zod";
import path from "node:path";

/**
 * Typed configuration loader. Reads from process.env with validation.
 * Throws on first call if required env vars are missing.
 */

const csv = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  databaseUrl: z.string().min(1, "DATABASE_URL is required"),
  redisUrl: z.string().min(1, "REDIS_URL is required"),

  discord: z.object({
    token: z.string().optional(),
    clientId: z.string().optional(),
    guildId: z.string().optional(),
    adminIds: z.array(z.string()).default([]),
  }),

  github: z.object({
    token: z.string().optional(),
  }),

  claude: z.object({
    apiKey: z.string().optional(),
    /** Long-lived OAuth token from `claude setup-token` (Max/Pro plans). */
    oauthToken: z.string().optional(),
    bin: z.string().default("claude"),
    timeoutMs: z.coerce.number().int().positive().default(900_000),
    maxOutputBytes: z.coerce.number().int().positive().default(2_000_000),
    /**
     * Auto-allow all tool calls (Bash/Edit/Write/etc.) instead of prompting.
     * Required for headless `--print` runs to make any file changes. The real
     * safety boundary is the per-task git worktree + the sandbox destructive
     * command refusal — see docs/SECURITY.md.
     */
    skipPermissions: z
      .preprocess((v) => (v === "false" || v === "0" ? false : true), z.boolean())
      .default(true),
  }),

  api: z.object({
    port: z.coerce.number().int().positive().default(4000),
    baseUrl: z.string().default("http://localhost:4000"),
  }),

  workspace: z.object({
    root: z.string().min(1),
  }),

  worker: z.object({
    concurrency: z.coerce.number().int().positive().default(2),
    taskTimeoutMs: z.coerce.number().int().positive().default(900_000),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const workspaceRoot = process.env.WORKSPACE_ROOT
    ? path.resolve(process.env.WORKSPACE_ROOT)
    : path.resolve(process.cwd(), "workspaces");

  const raw = {
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    discord: {
      token: process.env.DISCORD_TOKEN,
      clientId: process.env.DISCORD_CLIENT_ID,
      guildId: process.env.DISCORD_GUILD_ID,
      adminIds: csv(process.env.DISCORD_ADMIN_IDS),
    },
    github: {
      token: process.env.GITHUB_TOKEN,
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      bin: process.env.CLAUDE_BIN,
      timeoutMs: process.env.CLAUDE_TIMEOUT_MS,
      maxOutputBytes: process.env.CLAUDE_MAX_OUTPUT_BYTES,
      skipPermissions: process.env.CLAUDE_SKIP_PERMISSIONS,
    },
    api: {
      port: process.env.API_PORT,
      baseUrl: process.env.API_BASE_URL,
    },
    workspace: {
      root: workspaceRoot,
    },
    worker: {
      concurrency: process.env.WORKER_CONCURRENCY,
      taskTimeoutMs: process.env.TASK_TIMEOUT_MS,
    },
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Reset cached config — useful for tests. */
export function resetConfig() {
  cached = null;
}
