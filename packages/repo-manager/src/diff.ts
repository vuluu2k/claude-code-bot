import { diffNameStatus, diffPatch, diffStat, hasChanges } from "./git.js";

export interface DiffSummary {
  hasChanges: boolean;
  stat: string;
  nameStatus: string;
  /** Truncated patch — use for previews, not for applying. */
  preview: string;
  totalFiles: number;
  insertions: number;
  deletions: number;
}

const STATUS_LINE_RE = /^([A-Z])\s+(.+)$/;
const STAT_TOTAL_RE = /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/;

/**
 * Build a friendly diff summary against the worktree's base commit.
 * Defaults to comparing against `baseRef` (usually the branch's merge-base).
 */
export async function summarizeDiff(
  worktreePath: string,
  baseRef = "HEAD",
  opts: { previewBytes?: number } = {},
): Promise<DiffSummary> {
  const previewBytes = opts.previewBytes ?? 4_000;
  const dirty = await hasChanges(worktreePath);
  const [stat, names, patch] = await Promise.all([
    diffStat(worktreePath, baseRef),
    diffNameStatus(worktreePath, baseRef),
    diffPatch(worktreePath, baseRef),
  ]);

  let totalFiles = 0;
  let insertions = 0;
  let deletions = 0;
  const last = stat.trim().split("\n").at(-1) ?? "";
  const m = STAT_TOTAL_RE.exec(last);
  if (m) {
    totalFiles = Number(m[1] ?? 0);
    insertions = Number(m[2] ?? 0);
    deletions = Number(m[3] ?? 0);
  } else {
    totalFiles = names
      .split("\n")
      .filter((l) => STATUS_LINE_RE.test(l.trim())).length;
  }

  const preview =
    patch.length > previewBytes
      ? patch.slice(0, previewBytes) + "\n…[diff truncated]"
      : patch;

  return {
    hasChanges: dirty,
    stat,
    nameStatus: names,
    preview,
    totalFiles,
    insertions,
    deletions,
  };
}

/** Concise one-line summary suitable for Discord/embed titles. */
export function diffOneLiner(s: DiffSummary): string {
  if (!s.hasChanges) return "no changes";
  return `${s.totalFiles} file(s), +${s.insertions} / -${s.deletions}`;
}
