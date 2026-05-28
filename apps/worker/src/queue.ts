import IORedis from "ioredis";
import type { ConnectionOptions } from "bullmq";
import { loadConfig } from "@ccb/shared/config";

let _redis: IORedis | null = null;

/** Plain ioredis instance for pub/sub. */
export function getRedis(): IORedis {
  if (_redis) return _redis;
  const cfg = loadConfig();
  _redis = new IORedis(cfg.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return _redis;
}

/**
 * BullMQ connection — passed as plain options to avoid the dual-package
 * hazard between top-level `ioredis` and the one bundled inside `bullmq`.
 */
export function getBullConnection(): ConnectionOptions {
  return { url: loadConfig().redisUrl } as ConnectionOptions;
}

export async function closeRedis() {
  if (_redis) {
    _redis.disconnect();
    _redis = null;
  }
}
