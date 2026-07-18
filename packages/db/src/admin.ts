import { asc } from "drizzle-orm";
import type { Database } from "./client.js";
import { admin, securityQuestion } from "./schema.js";

export interface AdminRow {
  id: string;
  passwordHash: string;
  recoveryEnabled: boolean;
}

export interface SecurityQuestionRow {
  position: number;
  question: string;
  answerHash: string;
}

/** The single admin row, or null if setup has not happened yet. */
export async function getAdmin(db: Database): Promise<AdminRow | null> {
  const [row] = await db.select().from(admin).limit(1);
  if (!row) return null;
  return { id: row.id, passwordHash: row.passwordHash, recoveryEnabled: row.recoveryEnabled };
}

/**
 * Create the admin. The unique index on the constant `singleton` column makes a second
 * insert fail at the database level, backing the single-admin guarantee (FR-002).
 */
export async function createAdmin(
  db: Database,
  passwordHash: string,
  recoveryEnabled: boolean,
): Promise<AdminRow> {
  const [row] = await db
    .insert(admin)
    .values({ passwordHash, recoveryEnabled })
    .returning();
  return { id: row!.id, passwordHash: row!.passwordHash, recoveryEnabled: row!.recoveryEnabled };
}

export async function updateAdminPassword(db: Database, passwordHash: string): Promise<void> {
  await db.update(admin).set({ passwordHash });
}

export async function getSecurityQuestions(db: Database): Promise<SecurityQuestionRow[]> {
  const rows = await db.select().from(securityQuestion).orderBy(asc(securityQuestion.position));
  return rows.map((r) => ({ position: r.position, question: r.question, answerHash: r.answerHash }));
}

/** Replace all security questions atomically-ish (delete then insert). */
export async function replaceSecurityQuestions(
  db: Database,
  rows: SecurityQuestionRow[],
): Promise<void> {
  await db.delete(securityQuestion);
  if (rows.length > 0) {
    await db.insert(securityQuestion).values(rows);
  }
}
