import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { loginSession } from "./schema.js";

export type LoginStatus =
  | "pending"
  | "awaiting_user"
  | "connected"
  | "timed_out"
  | "failed";

export interface LoginSessionRow {
  id: string;
  serviceId: string;
  status: LoginStatus;
  confirmed: boolean;
  config: Record<string, string>;
  proxyCiphertext: Buffer | null;
  proxyDataKey: Buffer | null;
}

export interface NewLoginSession {
  config?: Record<string, string>;
  proxyCiphertext?: Buffer | null;
  proxyDataKey?: Buffer | null;
}

export async function createLoginSession(
  db: Database,
  serviceId: string,
  opts: NewLoginSession = {},
): Promise<string> {
  const [row] = await db
    .insert(loginSession)
    .values({
      serviceId,
      status: "pending",
      config: opts.config ?? {},
      proxyCiphertext: opts.proxyCiphertext ?? null,
      proxyDataKey: opts.proxyDataKey ?? null,
    })
    .returning({ id: loginSession.id });
  return row!.id;
}

export async function getLoginSession(db: Database, id: string): Promise<LoginSessionRow | null> {
  const [row] = await db.select().from(loginSession).where(eq(loginSession.id, id)).limit(1);
  return row
    ? {
        id: row.id,
        serviceId: row.serviceId,
        status: row.status as LoginStatus,
        confirmed: row.confirmed,
        config: (row.config as Record<string, string>) ?? {},
        proxyCiphertext: row.proxyCiphertext ?? null,
        proxyDataKey: row.proxyDataKey ?? null,
      }
    : null;
}

/** The operator has finished logging in and wants their session captured. */
export async function confirmLoginSession(db: Database, id: string): Promise<void> {
  await db.update(loginSession).set({ confirmed: true }).where(eq(loginSession.id, id));
}

export async function setLoginStatus(
  db: Database,
  id: string,
  status: LoginStatus,
): Promise<void> {
  await db
    .update(loginSession)
    .set({ status, updatedAt: new Date() })
    .where(eq(loginSession.id, id));
}
