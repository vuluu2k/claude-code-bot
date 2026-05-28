import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Apply pending migrations from the committed `drizzle/` folder. Safe to call
 * on every boot — drizzle tracks applied migrations and no-ops when current.
 * Uses its own single-connection pool so it can run before the app's pool.
 */
export async function runMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");
  // onnotice: swallow the "already exists, skipping" NOTICEs drizzle emits for
  // its own tracking schema/table on every run.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql);
    const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// CLI entry: `bun run src/migrate.ts`
if (import.meta.main) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
