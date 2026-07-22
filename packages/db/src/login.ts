import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { loginInput, loginSession } from "./schema.js";

export type LoginStatus =
  | "pending"
  | "awaiting_user"
  | "connected"
  | "timed_out"
  | "failed";

export type InputKind = "click" | "type" | "key" | "scroll";

export interface LoginSessionRow {
  id: string;
  serviceId: string;
  status: LoginStatus;
  confirmed: boolean;
  config: Record<string, string>;
  proxyCiphertext: Buffer | null;
  proxyDataKey: Buffer | null;
}

export interface InputEvent {
  kind: InputKind;
  payload: Record<string, unknown>;
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

export async function setLoginFrame(db: Database, id: string, frame: Buffer): Promise<void> {
  await db
    .update(loginSession)
    .set({ frame, updatedAt: new Date() })
    .where(eq(loginSession.id, id));
}

export async function getLoginFrame(db: Database, id: string): Promise<Buffer | null> {
  const [row] = await db
    .select({ frame: loginSession.frame })
    .from(loginSession)
    .where(eq(loginSession.id, id))
    .limit(1);
  return row?.frame ?? null;
}

/** Clear the transient frame (called when the session ends). */
export async function clearLoginFrame(db: Database, id: string): Promise<void> {
  await db.update(loginSession).set({ frame: null }).where(eq(loginSession.id, id));
}

export async function enqueueInput(
  db: Database,
  sessionId: string,
  event: InputEvent,
): Promise<void> {
  await db.insert(loginInput).values({ sessionId, kind: event.kind, payload: event.payload });
}

/**
 * Return the pending inputs for a session in FIFO order and DELETE them immediately. A single
 * worker drains a given session so there is no contention. Deleting (not just marking) ensures
 * relayed keystrokes — including password characters typed during login — do not linger in the
 * database in plaintext; they exist only in the brief window between enqueue and drain.
 */
export async function drainInputs(db: Database, sessionId: string): Promise<InputEvent[]> {
  const rows = await db
    .delete(loginInput)
    .where(eq(loginInput.sessionId, sessionId))
    .returning();
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return rows.map((r) => ({ kind: r.kind as InputKind, payload: r.payload as Record<string, unknown> }));
}
