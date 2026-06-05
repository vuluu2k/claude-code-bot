import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { ShellError, TimeoutError } from "./errors.js";

/**
 * Safe shell wrapper. Always uses an arg array (NEVER a shell string) to prevent
 * command injection from user-controlled inputs.
 */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Called for each chunk of stdout. */
  onStdout?: (chunk: string) => void;
  /** Called for each chunk of stderr. */
  onStderr?: (chunk: string) => void;
  /** Optional abort signal — cancels the child process. */
  signal?: AbortSignal;
  /** When true, non-zero exit codes do NOT throw. Default: throw. */
  allowFailure?: boolean;
  /** When true, mix stderr into stdout chunks (still separated in result). */
  stdin?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_TIMEOUT = 60_000;

/**
 * Standard executable directories that should always be searched. When the
 * server is launched by launchd / systemd / an IDE, PATH often lacks Homebrew
 * (`/opt/homebrew/bin`) or even `/usr/local/bin`, which makes `gh`, `git`,
 * `claude`, etc. fail to resolve even though they're installed. We prepend the
 * common locations so spawned subprocesses can find them.
 */
const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function augmentedPath(extra?: string): string {
  const sep = process.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (dir: string | undefined) => {
    if (!dir) return;
    if (seen.has(dir)) return;
    seen.add(dir);
    out.push(dir);
  };
  for (const part of (extra ?? "").split(sep)) push(part);
  for (const part of (process.env.PATH ?? "").split(sep)) push(part);
  for (const dir of EXTRA_PATH_DIRS) push(dir);
  return out.filter(Boolean).join(sep);
}

/**
 * Run a command with a fixed argv. NEVER pass shell metacharacters through `cmd`
 * — that is the entire point of this wrapper.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env as NodeJS.ProcessEnv | undefined),
    };
    mergedEnv.PATH = augmentedPath(mergedEnv.PATH);

    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      return reject(
        new ShellError(`Failed to spawn ${cmd}`, { stdout: "", stderr: String(err), exitCode: null }),
      );
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) {
        stdoutChunks.push(chunk);
        opts.onStdout?.(chunk.toString("utf8"));
      } else {
        truncated = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) {
        stderrChunks.push(chunk);
        opts.onStderr?.(chunk.toString("utf8"));
      } else {
        truncated = true;
      }
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(
        new ShellError(`Process error: ${err.message}`, {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: null,
        }),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);

      const stdout =
        Buffer.concat(stdoutChunks).toString("utf8") +
        (truncated ? "\n…[OUTPUT TRUNCATED]" : "");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const result: RunResult = {
        stdout,
        stderr,
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
      };

      if (timedOut) {
        return reject(new TimeoutError(`Command ${cmd} timed out after ${timeoutMs}ms`));
      }
      if (code !== 0 && !opts.allowFailure) {
        return reject(
          new ShellError(`Command ${cmd} exited with code ${code}`, {
            stdout,
            stderr,
            exitCode: code,
          }),
        );
      }
      resolve(result);
    });
  });
}
