import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { connectedAccount, consentRecord } from "./schema.js";

export type ConnectionMethod = "session_import" | "credential_totp";
export type AccountStatus = "connected" | "needs_reauth";

/** An active benefit observed on the account (mirrors the connectors' Entitlement). */
export interface Entitlement {
  kind: "prime_sub";
  channel?: string;
  endsAt?: string;
}

/** Non-secret facts observed during runs and surfaced in the dashboard. */
export interface AccountFacts {
  entitlements?: Entitlement[];
}

/** Public account view — never includes secret material (FR-008). */
export interface AccountRow {
  id: string;
  serviceId: string;
  method: ConnectionMethod;
  status: AccountStatus;
  fingerprint: unknown;
  /** The account's username on the service, when the connector has reported it. */
  displayName: string | null;
  facts: AccountFacts;
  factsUpdatedAt: Date | null;
  config: Record<string, string>;
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
    displayName: row.displayName ?? null,
    facts: (row.facts as AccountFacts) ?? {},
    factsUpdatedAt: row.factsUpdatedAt ?? null,
    config: (row.config as Record<string, string>) ?? {},
  };
}

/**
 * Persist the non-secret facts a connector observed during a run (username, entitlements).
 * Merged over the existing facts so a connector that only learns part of them doesn't wipe
 * the rest.
 */
export async function updateAccountFacts(
  db: Database,
  id: string,
  input: { displayName?: string; facts?: AccountFacts },
): Promise<void> {
  const [existing] = await db
    .select({ displayName: connectedAccount.displayName, facts: connectedAccount.facts })
    .from(connectedAccount)
    .where(eq(connectedAccount.id, id))
    .limit(1);
  if (!existing) return;
  await db
    .update(connectedAccount)
    .set({
      displayName: input.displayName ?? existing.displayName,
      facts: { ...((existing.facts as AccountFacts) ?? {}), ...(input.facts ?? {}) },
      factsUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(connectedAccount.id, id));
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

/**
 * Replace a connected account's stored secret (and optionally its config/proxy) — this is what
 * "reconnect" does when a service's session has expired. The account id, history and schedule are
 * kept; the status returns to `connected`.
 */
export async function replaceAccountSecret(
  db: Database,
  id: string,
  input: {
    method: ConnectionMethod;
    secretCiphertext: Buffer;
    secretDataKey: Buffer;
    fingerprint: unknown;
    config?: Record<string, string>;
    proxyCiphertext?: Buffer | null;
    proxyDataKey?: Buffer | null;
  },
): Promise<void> {
  await db
    .update(connectedAccount)
    .set({
      method: input.method,
      secretCiphertext: input.secretCiphertext,
      secretDataKey: input.secretDataKey,
      fingerprint: input.fingerprint,
      ...(input.config ? { config: input.config } : {}),
      proxyCiphertext: input.proxyCiphertext ?? null,
      proxyDataKey: input.proxyDataKey ?? null,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(connectedAccount.id, id));
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
