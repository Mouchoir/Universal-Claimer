import { eq } from "drizzle-orm";
import { appSetting } from "./schema.js";
import type { Database } from "./client.js";

/**
 * Deployment-level key/value settings. Two things live here today, and both exist because the
 * container is disposable while the data is not: the fingerprint of the encryption key this
 * database was written with, and the last release whose notes have been shown.
 */

/** Hash of the master key, so a swapped key is caught before it corrupts anything. */
export const MASTER_KEY_FINGERPRINT = "master_key_fingerprint";
/** Newest release whose patch notes the operator has already seen. */
export const LAST_SEEN_VERSION = "last_seen_version";

export async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, key))
    .limit(1);
  return row?.value ?? null;
}

export async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date() } });
}

/** Thrown when the stored data was encrypted with a different key than the one now configured. */
export class MasterKeyMismatchError extends Error {
  constructor() {
    super(
      "APP_ENCRYPTION_KEY does not match the key this database was written with. " +
        "Every stored account session was encrypted with the original key and cannot be read " +
        "with this one. Restore the original key, or wipe the database volume to start over.",
    );
    this.name = "MasterKeyMismatchError";
  }
}

/**
 * Record the key's fingerprint on first use, and refuse to run against data written with a
 * different one.
 *
 * Without this, a redeploy carrying a regenerated key starts up perfectly happily and only fails
 * later, one account at a time, as each stored session turns out to be undecryptable — by which
 * point the original key is usually gone. Failing loudly at boot turns a silent, permanent loss
 * into an incident with an obvious remedy.
 *
 * The fingerprint is a hash, not the key: reading the database does not reveal it.
 */
export async function assertMasterKeyMatches(db: Database, fingerprint: string): Promise<void> {
  const stored = await getSetting(db, MASTER_KEY_FINGERPRINT);
  if (stored === null) {
    await setSetting(db, MASTER_KEY_FINGERPRINT, fingerprint);
    return;
  }
  if (stored !== fingerprint) throw new MasterKeyMismatchError();
}
