import type { Database } from "./client.js";
import { notificationTarget } from "./schema.js";

export type NotificationKind = "discord" | "telegram" | "ntfy";

export interface NotificationTargetRow {
  id: string;
  kind: NotificationKind;
  configCiphertext: Buffer;
  configDataKey: Buffer;
}

/** The single optional outbound webhook target, or null if none configured. */
export async function getNotificationTarget(db: Database): Promise<NotificationTargetRow | null> {
  const [row] = await db.select().from(notificationTarget).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    configCiphertext: row.configCiphertext,
    configDataKey: row.configDataKey,
  };
}

/** Insert or replace the single notification target (encrypted config). */
export async function upsertNotificationTarget(
  db: Database,
  input: { kind: NotificationKind; configCiphertext: Buffer; configDataKey: Buffer },
): Promise<void> {
  await db
    .insert(notificationTarget)
    .values({
      kind: input.kind,
      configCiphertext: input.configCiphertext,
      configDataKey: input.configDataKey,
    })
    .onConflictDoUpdate({
      target: notificationTarget.singleton,
      set: {
        kind: input.kind,
        configCiphertext: input.configCiphertext,
        configDataKey: input.configDataKey,
      },
    });
}

export async function deleteNotificationTarget(db: Database): Promise<void> {
  await db.delete(notificationTarget);
}
