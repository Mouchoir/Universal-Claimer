import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig, loadMasterKey, masterKeyFingerprint } from "@uc/core";
import { assertMasterKeyMatches } from "./app-settings.js";
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

/**
 * Everything that must be true before the application starts: schema current, catalog seeded, and
 * the encryption key the same one this database was written with.
 *
 * The key check belongs here rather than in the app because it has to happen once, before any
 * process tries to read a stored secret. Discovering a mismatch later means discovering it one
 * account at a time, as a series of decryption failures, long after the correct key has been
 * lost — so this refuses to proceed instead.
 */
export async function preflight(databaseUrl: string, appEncryptionKey: string): Promise<void> {
  const handle = createDb(databaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder });
    await seedServices(handle.db);
    await assertMasterKeyMatches(handle.db, masterKeyFingerprint(loadMasterKey(appEncryptionKey)));
  } finally {
    await handle.close();
  }
}

// Allow `node dist/migrate.js` as a standalone entrypoint.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = loadConfig();
  preflight(cfg.DATABASE_URL, cfg.APP_ENCRYPTION_KEY)
    .then(() => {
      console.log("Migrations applied, services seeded, encryption key verified.");
      process.exit(0);
    })
    .catch((err: unknown) => {
      // The message on MasterKeyMismatchError is the whole remedy, so print it plainly rather
      // than as a stack trace an operator has to read past.
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
