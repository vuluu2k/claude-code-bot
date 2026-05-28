import { sandboxRun, defaultPolicy, type SandboxPolicy } from "@ccb/sandbox";
import { loadConfig } from "@ccb/shared/config";
import { makeLogger } from "@ccb/shared/logger";
import { TaskCancelledError, TimeoutError } from "@ccb/shared/errors";
import type { RunResult } from "@ccb/shared/shell";

const log = makeLogger("claude-runner");

export interface ClaudeRunInput {
  /** The composed prompt (system + memory + task). */
  prompt: string;
  /** The worktree path — Claude's cwd. */
  workspacePath: string;
  /** Optional run identifier for logging. */
  runId?: string;
  /**
   * Resume a prior Claude session by ID. When set, the new prompt is appended
   * to that session's transcript instead of starting fresh. The session id
   * comes from a previous run's stream-json output (events carry a `session_id`
   * field — see parseSessionId below).
   */
  resumeSessionId?: string;
  /** Streamed stdout chunks (Claude's responses + tool output). */
  onStdout?: (chunk: string) => void;
  /** Streamed stderr chunks. */
  onStderr?: (chunk: string) => void;
  /** Caller-supplied abort signal — cancels the run. */
  signal?: AbortSignal;
  /** Override default per-run timeout. */
  timeoutMs?: number;
  /** Override the sandbox policy used for this run. */
  policy?: SandboxPolicy;
  /** Extra args forwarded to the Claude CLI. */
  extraArgs?: string[];
}

export interface ClaudeRunResult {
  result: RunResult;
  cancelled: boolean;
  timedOut: boolean;
  /** Claude's session id parsed from the stream-json output, if any. */
  sessionId?: string;
}

/**
 * Run a Claude Code task headlessly in non-interactive mode.
 *
 * Implementation notes:
 *  - `--print` makes Claude pipe-friendly (one-shot, stdout-streaming).
 *  - `--output-format stream-json` emits a session_id per event so we can
 *    chain calls together with `--resume <id>` for multi-turn sessions.
 *  - `--dangerously-skip-permissions` is on by default; without it Claude
 *    cannot use tools in headless mode. Real safety lives in the worktree
 *    boundary + sandbox policy (see docs/SECURITY.md).
 */
export async function runClaudeTask(input: ClaudeRunInput): Promise<ClaudeRunResult> {
  const cfg = loadConfig();
  const policy: SandboxPolicy = input.policy ?? {
    ...defaultPolicy,
    timeoutMs: input.timeoutMs ?? cfg.claude.timeoutMs,
    maxOutputBytes: cfg.claude.maxOutputBytes,
  };

  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (cfg.claude.skipPermissions) args.push("--dangerously-skip-permissions");
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  if (input.extraArgs?.length) args.push(...input.extraArgs);
  args.push(input.prompt);

  // Auth: API key wins, OAuth token next; otherwise rely on cached credentials
  // from `claude /login` in the home volume.
  const authEnv: Record<string, string> = {};
  if (cfg.claude.apiKey) authEnv.ANTHROPIC_API_KEY = cfg.claude.apiKey;
  if (cfg.claude.oauthToken) authEnv.CLAUDE_CODE_OAUTH_TOKEN = cfg.claude.oauthToken;

  log.info(
    {
      runId: input.runId,
      workspacePath: input.workspacePath,
      promptChars: input.prompt.length,
      resume: input.resumeSessionId ?? null,
    },
    "starting claude run",
  );

  let sessionId: string | undefined;
  const sniffSession = (chunk: string) => {
    if (sessionId) return;
    const found = parseSessionId(chunk);
    if (found) sessionId = found;
  };

  try {
    const result = await sandboxRun(cfg.claude.bin, args, {
      workspacePath: input.workspacePath,
      policy,
      onStdout: (chunk) => {
        sniffSession(chunk);
        input.onStdout?.(chunk);
      },
      onStderr: input.onStderr,
      signal: input.signal,
      env: Object.keys(authEnv).length ? authEnv : undefined,
    });
    log.info(
      {
        runId: input.runId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sessionId: sessionId ?? null,
      },
      "claude run finished",
    );
    return { result, cancelled: false, timedOut: false, sessionId };
  } catch (err) {
    if (err instanceof TimeoutError) {
      log.warn({ runId: input.runId }, "claude run timed out");
      throw err;
    }
    if (input.signal?.aborted) {
      log.warn({ runId: input.runId }, "claude run cancelled");
      throw new TaskCancelledError(input.runId ?? "unknown");
    }
    log.error({ runId: input.runId, err }, "claude run failed");
    throw err;
  }
}

/**
 * Pull the first `session_id` field out of a stream-json chunk. Claude emits
 * one JSON object per line; we scan rather than fully parse to avoid choking
 * on partial chunks.
 */
function parseSessionId(chunk: string): string | undefined {
  const m = chunk.match(/"session_id"\s*:\s*"([^"]+)"/);
  return m?.[1];
}
