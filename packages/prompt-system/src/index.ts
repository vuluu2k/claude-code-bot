import path from "node:path";
import { promises as fs } from "node:fs";
import { MemoryStore, type RepoMemory } from "@ccb/memory-system";

export interface BuildPromptInput {
  repoSlug: string;
  worktreePath: string;
  task: string;
  extraContext?: string;
  /** Hard cap on total characters across all sections. */
  maxChars?: number;
}

export interface BuiltPrompt {
  systemPreamble: string;
  taskPrompt: string;
  full: string;
  sections: Record<string, string>;
}

const SYSTEM_PREAMBLE = `You are an AI software engineer running inside an isolated git worktree.

Operating rules:
- The worktree is a throwaway branch; commit small, focused changes.
- Stay strictly within the current worktree. Never modify the parent clone, other worktrees, or anything outside the workspace.
- Prefer the smallest change that fully solves the task. Do not refactor unrelated code.
- If you need to run shell commands, prefer non-destructive ones. Never run \`rm -rf\`, \`git push --force\`, \`git reset --hard\` on remote branches, or anything that requires sudo.
- When unsure about intent, ask a clarifying question in your final answer instead of guessing.
- End your run with a short summary: what changed, why, and any follow-ups.
`;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[truncated]";
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `## ${title}\n${trimmed}\n`;
}

async function readClaudeMd(worktreePath: string): Promise<string> {
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const p = path.join(worktreePath, name);
    try {
      const txt = await fs.readFile(p, "utf8");
      return txt;
    } catch {
      // continue
    }
  }
  return "";
}

export class PromptBuilder {
  constructor(private readonly memory: MemoryStore = new MemoryStore()) {}

  async build(input: BuildPromptInput): Promise<BuiltPrompt> {
    const maxChars = input.maxChars ?? 24_000;
    const mem: RepoMemory = await this.memory.load(input.repoSlug);
    const claudeMd = await readClaudeMd(input.worktreePath);

    const sections: Record<string, string> = {
      summary: truncate(mem.summary, 2_000),
      architecture: truncate(mem.architecture, 4_000),
      knownIssues: mem.knownIssues.map((i) => `- ${i}`).join("\n"),
      recentTasks: mem.recentTasks
        .slice(0, 5)
        .map((t) => `- [${t.status}] ${t.prompt.slice(0, 160)}`)
        .join("\n"),
      claudeMd: truncate(claudeMd, 6_000),
      extra: truncate(input.extraContext ?? "", 2_000),
    };

    const contextBlock = [
      section("Repository summary", sections.summary ?? ""),
      section("Architecture notes", sections.architecture ?? ""),
      section("Known issues", sections.knownIssues ?? ""),
      section("Recent tasks", sections.recentTasks ?? ""),
      section("Project CLAUDE.md", sections.claudeMd ?? ""),
      section("Additional context", sections.extra ?? ""),
    ]
      .filter(Boolean)
      .join("\n");

    const taskPrompt = [
      contextBlock,
      "## Task",
      input.task.trim(),
      "",
      "Begin work now. When finished, end with a short summary block.",
    ].join("\n");

    const full = truncate(`${SYSTEM_PREAMBLE}\n${taskPrompt}`, maxChars);
    return { systemPreamble: SYSTEM_PREAMBLE, taskPrompt, full, sections };
  }
}
