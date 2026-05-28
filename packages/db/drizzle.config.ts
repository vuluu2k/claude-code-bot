import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ccb:ccb@localhost:5432/ccb",
  },
  strict: true,
  verbose: true,
} satisfies Config;
