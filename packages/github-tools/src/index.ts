import { run } from "@ccb/shared/shell";
import { makeLogger } from "@ccb/shared/logger";
import { loadConfig } from "@ccb/shared/config";

const log = makeLogger("github-tools");

function ghEnv(): Record<string, string | undefined> {
  const cfg = loadConfig();
  return cfg.github.token ? { GH_TOKEN: cfg.github.token, GITHUB_TOKEN: cfg.github.token } : {};
}

/**
 * Run a `gh` CLI command. The CLI is preferred over Octokit so we get the
 * user's existing auth, repo aliases, and consistent behavior with manual use.
 */
export async function gh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  log.debug({ args, cwd: opts.cwd }, "gh");
  return run("gh", args, {
    cwd: opts.cwd,
    env: ghEnv(),
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
}

export interface PullRequestInput {
  cwd: string;
  title: string;
  body: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

export async function createPullRequest(input: PullRequestInput): Promise<string> {
  const args = ["pr", "create", "--title", input.title, "--body", input.body];
  if (input.base) args.push("--base", input.base);
  if (input.head) args.push("--head", input.head);
  if (input.draft) args.push("--draft");
  const r = await gh(args, { cwd: input.cwd });
  return r.stdout.trim();
}

export async function listIssues(cwd: string, limit = 10) {
  const r = await gh(
    ["issue", "list", "--limit", String(limit), "--json", "number,title,state,author,labels"],
    { cwd },
  );
  return JSON.parse(r.stdout) as Array<{
    number: number;
    title: string;
    state: string;
    author: { login: string };
    labels: Array<{ name: string }>;
  }>;
}

export async function getIssue(cwd: string, number: number) {
  const r = await gh(
    ["issue", "view", String(number), "--json", "number,title,body,state,author,labels,comments"],
    { cwd },
  );
  return JSON.parse(r.stdout);
}

export async function commitAll(cwd: string, message: string) {
  await run("git", ["add", "-A"], { cwd });
  // allowFailure: a clean tree (Claude already committed) makes commit exit 1.
  await run("git", ["commit", "-m", message], { cwd, allowFailure: true });
}

export async function pushBranch(cwd: string, branch: string) {
  await run("git", ["push", "-u", "origin", branch], { cwd });
}

/** Number of commits on HEAD not in `baseRef` (e.g. "origin/main"). */
export async function commitsAhead(cwd: string, baseRef: string): Promise<number> {
  const r = await run("git", ["rev-list", "--count", `${baseRef}..HEAD`], {
    cwd,
    allowFailure: true,
  });
  return Number(r.stdout.trim()) || 0;
}

/**
 * Return the URL of the PR for `branch`, creating one if it doesn't exist yet.
 * Subsequent pushes to the same branch update the existing PR automatically.
 */
export async function ensurePullRequest(opts: {
  cwd: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  try {
    const r = await gh(["pr", "view", opts.branch, "--json", "url", "--jq", ".url"], {
      cwd: opts.cwd,
    });
    const url = r.stdout.trim();
    if (url) return url;
  } catch {
    /* no PR yet — fall through to create */
  }
  return createPullRequest({
    cwd: opts.cwd,
    title: opts.title,
    body: opts.body,
    base: opts.base,
    head: opts.branch,
  });
}

/** Build a default commit message from a prompt + diff one-liner. */
export function suggestCommitMessage(prompt: string, diff?: string): string {
  const summary = prompt.split("\n")[0]?.slice(0, 70) ?? "automated change";
  const body = diff ? `\n\n${diff}` : "";
  return `chore(ai): ${summary}${body}`;
}
