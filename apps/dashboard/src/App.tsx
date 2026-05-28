import { useEffect, useState } from "react";

interface Repo {
  slug: string;
  remoteUrl: string;
  defaultBranch: string;
}
interface Task {
  id: string;
  repoSlug: string;
  status: string;
  prompt: string;
  branch?: string;
  diffSummary?: string;
  createdAt: string;
  finishedAt?: string;
}

const api = {
  repos: () => fetch("/api/repos").then((r) => r.json()) as Promise<{ repos: Repo[] }>,
  tasks: (repo?: string) =>
    fetch(`/api/tasks${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`).then((r) =>
      r.json(),
    ) as Promise<{ tasks: Task[] }>,
  task: (id: string) =>
    fetch(`/api/tasks/${id}`).then((r) => r.json()) as Promise<{ task: Task }>,
};

const statusColor: Record<string, string> = {
  queued: "bg-zinc-700",
  running: "bg-blue-600",
  succeeded: "bg-emerald-600",
  failed: "bg-red-600",
  cancelled: "bg-amber-600",
  timeout: "bg-orange-600",
};

function StatusBadge({ s }: { s: string }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full ${statusColor[s] ?? "bg-zinc-700"}`}>
      {s}
    </span>
  );
}

function TaskStream({ taskId }: { taskId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("…");

  useEffect(() => {
    setLines([]);
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === "stdout" || ev.type === "stderr") {
          setLines((prev) => [...prev.slice(-400), ev.data]);
        } else if (ev.type === "status") {
          setStatus(ev.status);
        }
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [taskId]);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-800 flex justify-between items-center">
        <span className="text-sm font-mono">{taskId}</span>
        <StatusBadge s={status} />
      </div>
      <pre className="bg-black p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap">
        {lines.join("")}
      </pre>
    </div>
  );
}

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>();
  const [selectedTask, setSelectedTask] = useState<string | undefined>();

  useEffect(() => {
    api.repos().then((r) => setRepos(r.repos)).catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = () =>
      api
        .tasks(selectedRepo)
        .then((r) => mounted && setTasks(r.tasks))
        .catch(() => {});
    load();
    const t = setInterval(load, 5_000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [selectedRepo]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="text-lg font-semibold">claude-code-bot</h1>
        <span className="text-xs text-zinc-500">self-hosted AI engineering platform</span>
      </header>

      <div className="flex-1 grid grid-cols-12 gap-6 p-6">
        <aside className="col-span-3 space-y-2">
          <h2 className="text-xs uppercase tracking-wider text-zinc-500">Repositories</h2>
          <button
            onClick={() => setSelectedRepo(undefined)}
            className={`block w-full text-left px-3 py-2 rounded ${!selectedRepo ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
          >
            All repos
          </button>
          {repos.map((r) => (
            <button
              key={r.slug}
              onClick={() => setSelectedRepo(r.slug)}
              className={`block w-full text-left px-3 py-2 rounded ${selectedRepo === r.slug ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
            >
              <div className="font-mono text-sm">{r.slug}</div>
              <div className="text-xs text-zinc-500 truncate">{r.remoteUrl}</div>
            </button>
          ))}
          {!repos.length && (
            <p className="text-xs text-zinc-500">
              No repositories registered. Use the Discord bot or POST /repos.
            </p>
          )}
        </aside>

        <main className="col-span-9 space-y-6">
          <section>
            <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Tasks</h2>
            <div className="overflow-hidden border border-zinc-800 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900 text-zinc-400 text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">ID</th>
                    <th className="text-left px-3 py-2">Repo</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Prompt</th>
                    <th className="text-left px-3 py-2">Diff</th>
                    <th className="text-left px-3 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedTask(t.id)}
                      className="border-t border-zinc-800 cursor-pointer hover:bg-zinc-900"
                    >
                      <td className="px-3 py-2 font-mono text-xs">{t.id.slice(-12)}</td>
                      <td className="px-3 py-2">{t.repoSlug}</td>
                      <td className="px-3 py-2">
                        <StatusBadge s={t.status} />
                      </td>
                      <td className="px-3 py-2 truncate max-w-md">{t.prompt}</td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{t.diffSummary ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-zinc-500">
                        {new Date(t.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  {!tasks.length && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-zinc-500">
                        No tasks yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {selectedTask && (
            <section>
              <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                Live stream
              </h2>
              <TaskStream taskId={selectedTask} />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
