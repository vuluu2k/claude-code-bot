import { run, type RunOptions } from "@ccb/shared/shell";
import { makeLogger } from "@ccb/shared/logger";
import { loadConfig } from "@ccb/shared/config";

const log = makeLogger("git");

/**
 * Build git env that (a) never prompts for credentials interactively — so a
 * missing/invalid token fails fast instead of hanging — and (b) injects the
 * GitHub token for github.com HTTPS remotes via an `insteadOf` rewrite passed
 * through env (GIT_CONFIG_*), so the token is NOT persisted into .git/config.
 */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  const token = loadConfig().github.token;
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `url.https://x-access-token:${token}@github.com/.insteadOf`;
    env.GIT_CONFIG_VALUE_0 = "https://github.com/";
  }
  return env;
}

/**
 * Thin wrapper around the `git` CLI. All callers MUST pass arguments as an array
 * — never interpolate user input into a single command string.
 */
export async function git(args: string[], opts: RunOptions = {}) {
  log.debug({ args, cwd: opts.cwd }, "git");
  return run("git", args, {
    timeoutMs: 120_000,
    ...opts,
    env: { ...gitEnv(), ...(opts.env ?? {}) },
  });
}

export async function clone(remoteUrl: string, dest: string, opts: { branch?: string } = {}) {
  const args = ["clone", "--quiet"];
  if (opts.branch) args.push("--branch", opts.branch);
  args.push("--", remoteUrl, dest);
  return git(args);
}

export async function fetchAll(repoPath: string) {
  return git(["fetch", "--all", "--prune"], { cwd: repoPath });
}

export async function pull(repoPath: string, branch?: string) {
  const args = ["pull", "--ff-only"];
  if (branch) args.push("origin", branch);
  return git(args, { cwd: repoPath });
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  const r = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (r.exitCode === 0) {
    return r.stdout.trim().replace(/^origin\//, "");
  }
  // Fallback — try `main` then `master`.
  for (const cand of ["main", "master"]) {
    const exists = await git(["rev-parse", "--verify", `refs/heads/${cand}`], {
      cwd: repoPath,
      allowFailure: true,
    });
    if (exists.exitCode === 0) return cand;
  }
  return "main";
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}) {
  // -B creates or resets the branch to the base — safe inside a worktree.
  return git(
    ["worktree", "add", "-B", opts.branch, opts.worktreePath, opts.baseBranch],
    { cwd: opts.repoPath },
  );
}

export async function removeWorktree(repoPath: string, worktreePath: string) {
  return git(["worktree", "remove", "--force", worktreePath], {
    cwd: repoPath,
    allowFailure: true,
  });
}

export async function pruneWorktrees(repoPath: string) {
  return git(["worktree", "prune"], { cwd: repoPath, allowFailure: true });
}

export async function listWorktrees(repoPath: string): Promise<
  Array<{ path: string; branch: string; head: string }>
> {
  const r = await git(["worktree", "list", "--porcelain"], { cwd: repoPath });
  const blocks = r.stdout.split("\n\n").filter(Boolean);
  return blocks.map((b) => {
    const entry: Record<string, string> = {};
    for (const line of b.split("\n")) {
      const [k, ...rest] = line.split(" ");
      if (k) entry[k] = rest.join(" ");
    }
    return {
      path: entry.worktree ?? "",
      branch: (entry.branch ?? "").replace(/^refs\/heads\//, ""),
      head: entry.HEAD ?? "",
    };
  });
}

export async function diffStat(worktreePath: string, baseRef = "HEAD"): Promise<string> {
  const r = await git(["diff", "--stat", `${baseRef}`], {
    cwd: worktreePath,
    allowFailure: true,
  });
  return r.stdout;
}

export async function diffNameStatus(worktreePath: string, baseRef = "HEAD"): Promise<string> {
  const r = await git(["diff", "--name-status", baseRef], {
    cwd: worktreePath,
    allowFailure: true,
  });
  return r.stdout;
}

export async function diffPatch(worktreePath: string, baseRef = "HEAD"): Promise<string> {
  const r = await git(["diff", baseRef], { cwd: worktreePath, allowFailure: true });
  return r.stdout;
}

export async function hasChanges(worktreePath: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], { cwd: worktreePath });
  return r.stdout.trim().length > 0;
}

export async function currentBranch(repoPath: string): Promise<string> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  return r.stdout.trim();
}

/**
 * Hard-rewind a worktree back to a clean state at `baseRef` (e.g. "origin/main"):
 * drop every committed and uncommitted change, then remove untracked files.
 * This powers the bot's /rewind. It is destructive *by design* but contained:
 * it only ever touches a per-thread throwaway worktree, never the main clone.
 */
export async function resetWorktree(worktreePath: string, baseRef: string) {
  // reset --hard moves HEAD + index + tracked files back to baseRef…
  await git(["reset", "--hard", baseRef], { cwd: worktreePath });
  // …and clean -fd removes any new untracked files/dirs Claude created.
  return git(["clean", "-fd"], { cwd: worktreePath });
}
