import { run } from "@ccb/shared/shell";
import { makeLogger } from "@ccb/shared/logger";

const log = makeLogger("tmux");

/**
 * Thin tmux wrapper for persistent sessions. We keep one session per
 * (repoSlug, sessionId) so an operator can reattach with `tmux attach -t <name>`
 * even after the Claude CLI exits.
 */

export function sessionName(repoSlug: string, sessionId: string): string {
  // tmux sessions can't contain "." or ":" — sanitize aggressively.
  return `ccb_${repoSlug}_${sessionId}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80);
}

export async function ensureSession(opts: { name: string; cwd: string }) {
  const exists = await run("tmux", ["has-session", "-t", opts.name], {
    allowFailure: true,
  });
  if (exists.exitCode === 0) return false;
  log.info({ name: opts.name, cwd: opts.cwd }, "creating tmux session");
  await run("tmux", ["new-session", "-d", "-s", opts.name, "-c", opts.cwd]);
  return true;
}

export async function sendKeys(name: string, command: string) {
  await run("tmux", ["send-keys", "-t", name, command, "Enter"]);
}

export async function capturePane(name: string, lines = 200): Promise<string> {
  const r = await run("tmux", ["capture-pane", "-pt", name, "-S", `-${lines}`], {
    allowFailure: true,
  });
  return r.stdout;
}

export async function killSession(name: string) {
  await run("tmux", ["kill-session", "-t", name], { allowFailure: true });
}

export async function tmuxAvailable(): Promise<boolean> {
  const r = await run("which", ["tmux"], { allowFailure: true });
  return r.exitCode === 0;
}
