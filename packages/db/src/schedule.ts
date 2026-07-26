import { and, eq, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { schedule } from "./schema.js";

export type Frequency = "daily" | "weekly";

export interface ScheduleInput {
  frequency: Frequency;
  hour: number;
  minute: number;
  dayOfWeek?: number | null; // required for weekly
  enabled: boolean;
  /** Randomize each run by up to ± this many minutes (0 = exact time). */
  jitterMinutes?: number;
  nextRunAt: Date | null;
}

export interface ScheduleRow extends ScheduleInput {
  id: string;
  connectedAccountId: string;
  lastRunAt: Date | null;
}

function toRow(r: typeof schedule.$inferSelect): ScheduleRow {
  return {
    id: r.id,
    connectedAccountId: r.connectedAccountId,
    frequency: r.frequency as Frequency,
    hour: r.hour,
    minute: r.minute,
    dayOfWeek: r.dayOfWeek,
    enabled: r.enabled,
    jitterMinutes: r.jitterMinutes,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
  };
}

export async function getSchedule(
  db: Database,
  connectedAccountId: string,
): Promise<ScheduleRow | null> {
  const [row] = await db
    .select()
    .from(schedule)
    .where(eq(schedule.connectedAccountId, connectedAccountId))
    .limit(1);
  return row ? toRow(row) : null;
}

/** Insert or replace the schedule for an account (one per account). */
export async function upsertSchedule(
  db: Database,
  connectedAccountId: string,
  input: ScheduleInput,
): Promise<void> {
  const values = {
    connectedAccountId,
    frequency: input.frequency,
    hour: input.hour,
    minute: input.minute,
    dayOfWeek: input.dayOfWeek ?? null,
    enabled: input.enabled,
    jitterMinutes: input.jitterMinutes ?? 0,
    nextRunAt: input.nextRunAt,
    updatedAt: new Date(),
  };
  await db
    .insert(schedule)
    .values(values)
    .onConflictDoUpdate({ target: schedule.connectedAccountId, set: values });
}

export async function deleteSchedule(db: Database, connectedAccountId: string): Promise<void> {
  await db.delete(schedule).where(eq(schedule.connectedAccountId, connectedAccountId));
}

/** Enabled schedules whose nextRunAt is due (<= now). */
export async function listDueSchedules(db: Database, now: Date): Promise<ScheduleRow[]> {
  const rows = await db
    .select()
    .from(schedule)
    .where(and(eq(schedule.enabled, true), lte(schedule.nextRunAt, now)));
  return rows.map(toRow);
}

/** Advance a schedule after a run: set lastRunAt=now and the new nextRunAt. */
export async function markScheduleRan(
  db: Database,
  id: string,
  now: Date,
  nextRunAt: Date,
): Promise<void> {
  await db
    .update(schedule)
    .set({ lastRunAt: now, nextRunAt, updatedAt: now })
    .where(eq(schedule.id, id));
}
