import { randomBytes } from "node:crypto";
import { getRedis } from "./queue.js";

/**
 * Minimal Redis mutex (Redlock-lite, single-node). Good enough for serializing
 * tasks within a Discord thread so two messages never edit the same worktree
 * concurrently. Crash-safe via TTL: if a worker dies holding a lock, it expires.
 */

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export function threadLockKey(threadId: string) {
  return `ccb:lock:thread:${threadId}`;
}

/** Try once to acquire. Returns a release token on success, null if held. */
export async function tryAcquire(key: string, ttlMs: number): Promise<string | null> {
  const token = randomBytes(16).toString("hex");
  const res = await getRedis().set(key, token, "PX", ttlMs, "NX");
  return res === "OK" ? token : null;
}

export async function release(key: string, token: string): Promise<void> {
  await getRedis().eval(RELEASE_LUA, 1, key, token);
}
