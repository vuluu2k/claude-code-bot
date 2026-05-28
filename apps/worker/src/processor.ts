import { eq } from "drizzle-orm";
import { getDb, tasks, taskLogs, sessions, threads } from "@ccb/db";
import { EVENT_CHANNEL, type StreamEvent } from "@ccb/shared";
import { makeLogger } from "@ccb/shared/logger";
import { shortId } from "@ccb/shared/ids";
import { isCcbError, TaskCancelledError, TimeoutError } from "@ccb/shared/errors";
import { RepoRegistry, WorktreeManager, summarizeDiff, diffOneLiner } from "@ccb/repo-manager";
import { MemoryStore } from "@ccb/memory-system";
import { PromptBuilder } from "@ccb/prompt-system";
import { runClaudeTask } from "@ccb/claude-runner";
import {
  commitAll,
  commitsAhead,
  pushBranch,
  ensurePullRequest,
  suggestCommitMessage,
} from "@ccb/github-tools";
import { getRedis } from "./queue.js";

const log = makeLogger("worker.processor");

export interface TaskJobData {
  taskId: string;
  repoSlug: string;
  prompt: string;
  sessionId?: string;
  channelId?: string;
  requestedBy?: string;
  baseBranch?: string;
  threadId?: string;
}

export interface ProcessOptions {
  signal?: AbortSignal;
}

const registry = new RepoRegistry();
const worktrees = new WorktreeManager(registry);
const memory = new MemoryStore();
const prompts = new PromptBuilder(memory);

async function publish(taskId: string, ev: StreamEvent) {
  await getRedis().publish(EVENT_CHANNEL(taskId), JSON.stringify(ev));
}

async function persistLog(taskId: string, stream: "stdout" | "stderr" | "system", chunk: string) {
  // Cap individual log row size — long output is split into many rows.
  const MAX = 16_000;
  for (let i = 0; i < chunk.length; i += MAX) {
    await getDb().insert(taskLogs).values({
      id: shortId("log"),
      taskId,
      stream,
      chunk: chunk.slice(i, i + MAX),
    });
  }
}

async function updateStatus(
  taskId: string,
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout",
  extra: Partial<{
    worktreePath: string;
    branch: string;
    diffSummary: string;
    exitCode: number | null;
    error: string;
    startedAt: Date;
    finishedAt: Date;
  }> = {},
) {
  await getDb()
    .update(tasks)
    .set({ status, ...extra })
    .where(eq(tasks.id, taskId));
  await publish(taskId, { type: "status", taskId, status, at: Date.now() });
}

export async function processTask(data: TaskJobData, opts: ProcessOptions = {}): Promise<void> {
  const { taskId, repoSlug, prompt } = data;
  log.info({ taskId, repoSlug }, "processing task");

  await updateStatus(taskId, "running", { startedAt: new Date() });

  // 1. Verify repo exists and is fresh.
  await registry.ensureFresh(repoSlug);

  // 2. Worktree. Thread tasks reuse the thread's persistent worktree so edits
  //    accumulate across the conversation; one-off tasks get a fresh throwaway.
  const wt = data.threadId
    ? await worktrees.getOrCreate({
        repoSlug,
        key: data.threadId,
        baseBranch: data.baseBranch,
      })
    : await worktrees.create({
        repoSlug,
        taskId,
        baseBranch: data.baseBranch,
      });
  await getDb()
    .update(tasks)
    .set({ worktreePath: wt.path, branch: wt.branch })
    .where(eq(tasks.id, taskId));
  if (data.threadId) {
    await getDb()
      .update(threads)
      .set({ worktreePath: wt.path, branch: wt.branch, updatedAt: new Date() })
      .where(eq(threads.id, data.threadId))
      .catch((e) => log.warn({ err: e }, "persisting thread worktree failed"));
  }

  // 3. Build the full prompt with memory + CLAUDE.md.
  const built = await prompts.build({
    repoSlug,
    worktreePath: wt.path,
    task: prompt,
  });

  // 4a. Resolve the prior Claude session id to chain context via --resume.
  //     Thread binding wins over an explicit session id.
  let resumeSessionId: string | undefined;
  if (data.threadId) {
    const rows = await getDb()
      .select({ claudeSessionId: threads.claudeSessionId })
      .from(threads)
      .where(eq(threads.id, data.threadId))
      .limit(1);
    resumeSessionId = rows[0]?.claudeSessionId ?? undefined;
  } else if (data.sessionId) {
    const rows = await getDb()
      .select({ claudeSessionId: sessions.claudeSessionId })
      .from(sessions)
      .where(eq(sessions.id, data.sessionId))
      .limit(1);
    resumeSessionId = rows[0]?.claudeSessionId ?? undefined;
  }

  // 4b. Run Claude inside the worktree, streaming output to Redis pub/sub.
  let exitCode: number | null = null;
  let runError: Error | null = null;
  let newClaudeSessionId: string | undefined;
  try {
    const { result, sessionId: cliSessionId } = await runClaudeTask({
      runId: taskId,
      prompt: built.full,
      workspacePath: wt.path,
      resumeSessionId,
      signal: opts.signal,
      onStdout: (chunk) => {
        publish(taskId, { type: "stdout", taskId, data: chunk, at: Date.now() }).catch(() => {});
        persistLog(taskId, "stdout", chunk).catch((e) =>
          log.warn({ err: e }, "persistLog stdout failed"),
        );
      },
      onStderr: (chunk) => {
        publish(taskId, { type: "stderr", taskId, data: chunk, at: Date.now() }).catch(() => {});
        persistLog(taskId, "stderr", chunk).catch((e) =>
          log.warn({ err: e }, "persistLog stderr failed"),
        );
      },
    });
    exitCode = result.exitCode;
    newClaudeSessionId = cliSessionId;
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
  }

  // 4c. Persist the (new or refreshed) Claude session id back to its owner.
  if (newClaudeSessionId) {
    if (data.threadId) {
      await getDb()
        .update(threads)
        .set({ claudeSessionId: newClaudeSessionId, updatedAt: new Date() })
        .where(eq(threads.id, data.threadId))
        .catch((e) => log.warn({ err: e }, "persisting thread claudeSessionId failed"));
    } else if (data.sessionId) {
      await getDb()
        .update(sessions)
        .set({ claudeSessionId: newClaudeSessionId, updatedAt: new Date() })
        .where(eq(sessions.id, data.sessionId))
        .catch((e) => log.warn({ err: e }, "persisting claudeSessionId failed"));
    }
  }

  // 5. Capture diff summary against the branch base, so it reflects ALL changes
  //    on the branch whether Claude committed them or left them uncommitted.
  const baseRef = `origin/${wt.baseBranch}`;
  let diffLine = "no changes";
  try {
    const summary = await summarizeDiff(wt.path, baseRef);
    diffLine = diffOneLiner(summary);
    await publish(taskId, { type: "diff", taskId, summary: summary.preview, at: Date.now() });
  } catch (e) {
    log.warn({ err: e, taskId }, "diff summarization failed");
  }

  // 5b. Auto-PR: on success, if the branch has changes, commit any leftovers,
  //     push, and open (or update) a pull request — no need to ask Claude.
  if (!runError && process.env.AUTO_PR !== "false") {
    try {
      await commitAll(wt.path, suggestCommitMessage(prompt, diffLine));
      const ahead = await commitsAhead(wt.path, baseRef);
      if (ahead > 0) {
        await pushBranch(wt.path, wt.branch);
        const prUrl = await ensurePullRequest({
          cwd: wt.path,
          branch: wt.branch,
          base: wt.baseBranch,
          title: prompt.split("\n")[0]!.slice(0, 70),
          body: `Automated by claude-code-bot.\n\nTask: ${prompt}\n\nChanges: ${diffLine}`,
        });
        await publish(taskId, {
          type: "stdout",
          taskId,
          data: `\n🔗 Pull request: ${prUrl}\n`,
          at: Date.now(),
        });
        log.info({ taskId, prUrl }, "opened/updated pull request");
      }
    } catch (e) {
      log.warn({ err: e, taskId }, "auto-PR failed");
      await publish(taskId, {
        type: "stderr",
        taskId,
        data: `\n⚠️ Auto-PR failed: ${(e as Error).message}\n`,
        at: Date.now(),
      }).catch(() => {});
    }
  }

  // 6. Persist final status.
  if (runError instanceof TaskCancelledError) {
    await updateStatus(taskId, "cancelled", {
      diffSummary: diffLine,
      exitCode,
      error: runError.message,
      finishedAt: new Date(),
    });
  } else if (runError instanceof TimeoutError) {
    await updateStatus(taskId, "timeout", {
      diffSummary: diffLine,
      exitCode,
      error: runError.message,
      finishedAt: new Date(),
    });
  } else if (runError) {
    await updateStatus(taskId, "failed", {
      diffSummary: diffLine,
      exitCode,
      error: isCcbError(runError) ? runError.message : runError.message,
      finishedAt: new Date(),
    });
  } else {
    await updateStatus(taskId, "succeeded", {
      diffSummary: diffLine,
      exitCode,
      finishedAt: new Date(),
    });
  }

  // 7. Update repo memory with the recent task.
  await memory
    .recordTask(repoSlug, {
      id: taskId,
      prompt,
      status: runError ? "failed" : "succeeded",
      diffSummary: diffLine,
      at: new Date().toISOString(),
    })
    .catch((e) => log.warn({ err: e }, "memory.recordTask failed"));

  if (runError) throw runError;
}
