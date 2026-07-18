import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "@uc/core";
import { createDb } from "./client.js";
import { seedServices } from "./seed.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Apply pending migrations and seed the service catalog. Run on web startup / via CLI. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder });
    await seedServices(handle.db);
  } finally {
    await handle.close();
  }
}

// Allow `node dist/migrate.js` as a standalone entrypoint.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = loadConfig();
  runMigrations(cfg.DATABASE_URL)
    .then(() => {
      console.log("Migrations applied and services seeded.");
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
