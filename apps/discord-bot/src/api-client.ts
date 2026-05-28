import { loadConfig } from "@ccb/shared/config";

const base = () => loadConfig().api.baseUrl.replace(/\/$/, "");

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface Repo {
  slug: string;
  remoteUrl: string;
  defaultBranch: string;
  description?: string | null;
}
export interface Task {
  id: string;
  repoSlug: string;
  status: string;
  prompt: string;
  worktreePath?: string;
  branch?: string;
  diffSummary?: string;
  exitCode?: number | null;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}
export interface TaskLog {
  id: string;
  taskId: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
  at: string;
}

export const client = {
  listRepos: () => api<{ repos: Repo[] }>("GET", "/repos"),
  registerRepo: (slug: string, remoteUrl: string, defaultBranch?: string) =>
    api<{ repo: Repo }>("POST", "/repos", { slug, remoteUrl, defaultBranch }),
  createTask: (input: {
    repoSlug: string;
    prompt: string;
    requestedBy?: string;
    channelId?: string;
    sessionId?: string;
    baseBranch?: string;
    threadId?: string;
  }) => api<{ task: Task }>("POST", "/tasks", input),
  registerThread: (input: {
    id: string;
    repoSlug: string;
    channelId?: string;
    createdBy?: string;
  }) =>
    api<{ thread: { id: string; repoSlug: string; status: string } }>(
      "POST",
      "/threads",
      input,
    ),
  getThread: (id: string) =>
    api<{ thread: { id: string; repoSlug: string; status: string; worktreePath?: string } }>(
      "GET",
      `/threads/${id}`,
    ),
  closeThread: (id: string) => api<{ ok: true }>("POST", `/threads/${id}/close`),
  getTask: (id: string) => api<{ task: Task }>("GET", `/tasks/${id}`),
  getLogs: (id: string) => api<{ logs: TaskLog[] }>("GET", `/tasks/${id}/logs`),
  cancelTask: (id: string) => api<{ ok: true }>("POST", `/tasks/${id}/cancel`),
  getDiff: (id: string) =>
    api<{ diff: { stat: string; preview: string; totalFiles: number; insertions: number; deletions: number; hasChanges: boolean } | null }>(
      "GET",
      `/diffs/${id}`,
    ),
  listSessions: (repoSlug?: string) =>
    api<{ sessions: Array<{ id: string; repoSlug: string; title?: string; createdAt: string }> }>(
      "GET",
      `/sessions${repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : ""}`,
    ),
  createSession: (repoSlug: string, title?: string) =>
    api<{ session: { id: string; repoSlug: string; title?: string } }>(
      "POST",
      "/sessions",
      { repoSlug, title },
    ),
  /** Server-Sent Events stream for live task updates. */
  streamUrl: (id: string) => `${base()}/tasks/${id}/stream`,
};
