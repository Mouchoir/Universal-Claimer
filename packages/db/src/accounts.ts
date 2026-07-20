import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { connectedAccount, consentRecord } from "./schema.js";

export type ConnectionMethod = "session_import" | "credential_totp";
export type AccountStatus = "connected" | "needs_reauth";

/** Public account view — never includes secret material (FR-008). */
export interface AccountRow {
  id: string;
  serviceId: string;
  method: ConnectionMethod;
  status: AccountStatus;
  fingerprint: unknown;
}

export interface NewAccount {
  serviceId: string;
  method: ConnectionMethod;
  secretCiphertext: Buffer;
  secretDataKey: Buffer;
  fingerprint: unknown;
  config?: Record<string, string>;
  proxyCiphertext?: Buffer | null;
  proxyDataKey?: Buffer | null;
}

/** Sealed secret + metadata, for the worker to open at claim time (never sent to clients). */
export interface AccountSecret {
  id: string;
  serviceId: string;
  method: ConnectionMethod;
  secretCiphertext: Buffer;
  secretDataKey: Buffer;
  fingerprint: unknown;
  config: Record<string, string>;
  proxyCiphertext: Buffer | null;
  proxyDataKey: Buffer | null;
}

function toPublic(row: typeof connectedAccount.$inferSelect): AccountRow {
  return {
    id: row.id,
    serviceId: row.serviceId,
    method: row.method as ConnectionMethod,
    status: row.status as AccountStatus,
    fingerprint: row.fingerprint,
  };
}

export async function getAccountByService(
  db: Database,
  serviceId: string,
): Promise<AccountRow | null> {
  const [row] = await db
    .select()
    .from(connectedAccount)
    .where(eq(connectedAccount.serviceId, serviceId))
    .limit(1);
  return row ? toPublic(row) : null;
}

export async function getAccount(db: Database, id: string): Promise<AccountRow | null> {
  const [row] = await db
    .select()
    .from(connectedAccount)
    .where(eq(connectedAccount.id, id))
    .limit(1);
  return row ? toPublic(row) : null;
}

export async function listAccounts(db: Database): Promise<AccountRow[]> {
  const rows = await db.select().from(connectedAccount).orderBy(desc(connectedAccount.createdAt));
  return rows.map(toPublic);
}

/** Full sealed secret for one account — worker use only. */
export async function getAccountSecret(db: Database, id: string): Promise<AccountSecret | null> {
  const [row] = await db
    .select()
    .from(connectedAccount)
    .where(eq(connectedAccount.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    serviceId: row.serviceId,
    method: row.method as ConnectionMethod,
    secretCiphertext: row.secretCiphertext,
    secretDataKey: row.secretDataKey,
    fingerprint: row.fingerprint,
    config: (row.config as Record<string, string>) ?? {},
    proxyCiphertext: row.proxyCiphertext ?? null,
    proxyDataKey: row.proxyDataKey ?? null,
  };
}

export async function createAccount(db: Database, input: NewAccount): Promise<AccountRow> {
  const [row] = await db
    .insert(connectedAccount)
    .values({
      serviceId: input.serviceId,
      method: input.method,
      secretCiphertext: input.secretCiphertext,
      secretDataKey: input.secretDataKey,
      fingerprint: input.fingerprint,
      config: input.config ?? {},
      proxyCiphertext: input.proxyCiphertext ?? null,
      proxyDataKey: input.proxyDataKey ?? null,
    })
    .returning();
  return toPublic(row!);
}

export async function updateAccountStatus(
  db: Database,
  id: string,
  status: AccountStatus,
): Promise<void> {
  await db
    .update(connectedAccount)
    .set({ status, updatedAt: new Date() })
    .where(eq(connectedAccount.id, id));
}

export async function deleteAccount(db: Database, id: string): Promise<void> {
  await db.delete(connectedAccount).where(eq(connectedAccount.id, id));
}

export async function recordConsent(
  db: Database,
  serviceId: string,
  tosWarningSnapshot: string,
): Promise<Date> {
  const [row] = await db
    .insert(consentRecord)
    .values({ serviceId, tosWarningSnapshot })
    .returning({ acceptedAt: consentRecord.acceptedAt });
  return row!.acceptedAt;
}

export async function hasConsent(db: Database, serviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: consentRecord.id })
    .from(consentRecord)
    .where(eq(consentRecord.serviceId, serviceId))
    .limit(1);
  return row !== undefined;
}
