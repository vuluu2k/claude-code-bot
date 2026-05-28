import { randomBytes } from "node:crypto";

/**
 * Compact, sortable-ish IDs. Not ULID-strict but URL-safe and unique enough for
 * task/session/run identifiers across the platform.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function shortId(prefix?: string, len = 10): string {
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length];
  }
  const ts = Date.now().toString(36);
  const id = `${ts}-${out}`;
  return prefix ? `${prefix}_${id}` : id;
}

export const newTaskId = () => shortId("task");
export const newSessionId = () => shortId("ses");
export const newRunId = () => shortId("run");
export const newWorktreeBranch = () => `ccb/${shortId("t", 6).replace("t_", "")}`;
