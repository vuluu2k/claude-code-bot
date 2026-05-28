import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadConfig } from "@ccb/shared/config";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Lazy singleton db connection. Tests that need isolation can call closeDb()
 * between runs.
 */
export function getDb() {
  if (_db) return _db;
  const cfg = loadConfig();
  _sql = postgres(cfg.databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  _db = drizzle(_sql, { schema });
  return _db;
}

export async function closeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}

export type Db = ReturnType<typeof getDb>;
