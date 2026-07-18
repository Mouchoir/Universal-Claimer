import { loadConfig, loadMasterKey, type AppConfig } from "@uc/core";
import { createDb, createQueue, type DbHandle } from "@uc/db";
import type PgBoss from "pg-boss";
import { DrizzleAdminStore } from "./store.js";

/**
 * Lazily-initialized process singletons for the web app: config, DB handle, master key, and
 * the admin store. Kept out of module top-level so importing server modules in tests does
 * not require a database connection.
 */

let config: AppConfig | null = null;
let handle: DbHandle | null = null;
let masterKey: Buffer | null = null;

export function getConfig(): AppConfig {
  if (!config) config = loadConfig();
  return config;
}

export function getMasterKeyB64(): string {
  return getConfig().APP_ENCRYPTION_KEY;
}

export function getMasterKey(): Buffer {
  if (!masterKey) masterKey = loadMasterKey(getConfig().APP_ENCRYPTION_KEY);
  return masterKey;
}

export function getDb(): DbHandle {
  if (!handle) handle = createDb(getConfig().DATABASE_URL);
  return handle;
}

export function getAdminStore(): DrizzleAdminStore {
  return new DrizzleAdminStore(getDb().db);
}

let queuePromise: Promise<PgBoss> | null = null;

/** Lazily-started pg-boss instance for enqueuing claim jobs (cached per process). */
export function getQueue(): Promise<PgBoss> {
  if (!queuePromise) queuePromise = createQueue(getConfig().DATABASE_URL);
  return queuePromise;
}
