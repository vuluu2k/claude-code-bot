import path from "node:path";
import { run, type RunOptions, type RunResult } from "@ccb/shared/shell";
import { ValidationError } from "@ccb/shared/errors";

/**
 * Sandbox policy. Two modes:
 *   - "host"    — run directly on the host inside an isolated cwd (worktree).
 *                 Cheapest, fastest. Use on trusted self-hosted VPS.
 *   - "docker"  — wrap the command inside a Docker container with mounted
 *                 worktree, no network by default, capped CPU/mem, non-root user.
 */
export type SandboxMode = "host" | "docker";

export interface SandboxPolicy {
  mode: SandboxMode;
  /** Wall-clock timeout for a single command. */
  timeoutMs: number;
  /** Max captured stdout/stderr bytes per command. */
  maxOutputBytes: number;
  /** Whitelist for tool binaries that may be invoked. Empty = allow any. */
  allowedBins?: string[];
  /** Docker-only options. */
  docker?: {
    image: string;
    user?: string;
    cpus?: string;
    memory?: string;
    network?: "none" | "bridge";
    extraEnv?: string[];
  };
}

export const defaultPolicy: SandboxPolicy = {
  mode: (process.env.SANDBOX_MODE === "docker" ? "docker" : "host") as SandboxMode,
  timeoutMs: 15 * 60 * 1000,
  maxOutputBytes: 2_000_000,
  docker: {
    image: process.env.SANDBOX_IMAGE ?? "ghcr.io/anthropics/claude-code:latest",
    user: "1000:1000",
    cpus: "2",
    memory: "2g",
    network: "bridge",
  },
};

const DANGEROUS = [
  /\brm\s+-rf\s+\//,
  /:\(\)\{:\|:&\};:/,
  /\bdd\s+if=.+of=\/dev\//,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
];

/**
 * Light-weight defense: rejects obviously destructive command lines before they
 * reach the sandbox. This is NOT the only line of defense — the worktree
 * boundary and Docker policy do the real isolation.
 */
export function assertCommandAllowed(cmd: string, args: string[], policy = defaultPolicy) {
  const line = [cmd, ...args].join(" ");
  for (const re of DANGEROUS) {
    if (re.test(line)) {
      throw new ValidationError(`refused: command matches destructive pattern (${re})`);
    }
  }
  if (policy.allowedBins && policy.allowedBins.length > 0) {
    if (!policy.allowedBins.includes(path.basename(cmd))) {
      throw new ValidationError(`refused: binary not in allow-list: ${cmd}`);
    }
  }
}

export interface SandboxRunOpts extends Omit<RunOptions, "timeoutMs" | "maxOutputBytes"> {
  workspacePath: string;
  policy?: SandboxPolicy;
}

/**
 * Run a command inside the sandbox boundary. The CWD is forced to the worktree;
 * callers cannot escape the workspace by passing `..` because Docker mounts a
 * single dir and the host-mode runner resolves the workspace path absolutely.
 */
export async function sandboxRun(
  cmd: string,
  args: string[],
  opts: SandboxRunOpts,
): Promise<RunResult> {
  const policy = opts.policy ?? defaultPolicy;
  assertCommandAllowed(cmd, args, policy);

  const workspace = path.resolve(opts.workspacePath);
  const baseOpts: RunOptions = {
    ...opts,
    cwd: workspace,
    timeoutMs: policy.timeoutMs,
    maxOutputBytes: policy.maxOutputBytes,
  };

  if (policy.mode === "host") {
    return run(cmd, args, baseOpts);
  }

  const d = policy.docker!;
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,source=${workspace},target=/workspace`,
    "--cpus",
    d.cpus ?? "2",
    "--memory",
    d.memory ?? "2g",
    "--network",
    d.network ?? "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
  ];
  if (d.user) dockerArgs.push("--user", d.user);
  for (const e of d.extraEnv ?? []) dockerArgs.push("-e", e);
  dockerArgs.push(d.image, cmd, ...args);

  return run("docker", dockerArgs, baseOpts);
}
