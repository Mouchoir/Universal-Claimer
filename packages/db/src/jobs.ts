import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import { connectedAccount, job } from "./schema.js";

export type JobState =
  | "queued"
  | "running"
  | "requires_human_action"
  | "succeeded"
  | "failed";
export type JobOutcome = "claimed" | "nothing_to_claim" | "failed" | "reauth_needed";

const ACTIVE_STATES: JobState[] = ["queued", "running", "requires_human_action"];

export interface JobRow {
  id: string;
  connectedAccountId: string;
  serviceId: string;
  state: JobState;
  outcome: JobOutcome | null;
  summary: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export async function createJob(db: Database, connectedAccountId: string): Promise<string> {
  const [row] = await db
    .insert(job)
    .values({ connectedAccountId, state: "queued" })
    .returning({ id: job.id });
  return row!.id;
}

export async function markRunning(db: Database, id: string): Promise<void> {
  await db.update(job).set({ state: "running", startedAt: new Date() }).where(eq(job.id, id));
}

export async function markRequiresHumanAction(db: Database, id: string): Promise<void> {
  await db.update(job).set({ state: "requires_human_action" }).where(eq(job.id, id));
}

export async function finishJob(
  db: Database,
  id: string,
  outcome: JobOutcome,
  summary: string,
): Promise<void> {
  const state: JobState =
    outcome === "claimed" || outcome === "nothing_to_claim" ? "succeeded" : "failed";
  await db
    .update(job)
    .set({ state, outcome, summary, finishedAt: new Date() })
    .where(eq(job.id, id));
}

/** True if the account already has a non-terminal job (enforces "no concurrent claim"). */
export async function hasActiveJobForAccount(
  db: Database,
  connectedAccountId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.connectedAccountId, connectedAccountId), inArray(job.state, ACTIVE_STATES)))
    .limit(1);
  return row !== undefined;
}

function mapRow(row: {
  job: typeof job.$inferSelect;
  serviceId: string;
}): JobRow {
  return {
    id: row.job.id,
    connectedAccountId: row.job.connectedAccountId,
    serviceId: row.serviceId,
    state: row.job.state as JobState,
    outcome: (row.job.outcome as JobOutcome | null) ?? null,
    summary: row.job.summary,
    createdAt: row.job.createdAt,
    startedAt: row.job.startedAt,
    finishedAt: row.job.finishedAt,
  };
}

export async function getJob(db: Database, id: string): Promise<JobRow | null> {
  const [row] = await db
    .select({ job, serviceId: connectedAccount.serviceId })
    .from(job)
    .innerJoin(connectedAccount, eq(job.connectedAccountId, connectedAccount.id))
    .where(eq(job.id, id))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function listJobs(db: Database, limit = 50): Promise<JobRow[]> {
  const rows = await db
    .select({ job, serviceId: connectedAccount.serviceId })
    .from(job)
    .innerJoin(connectedAccount, eq(job.connectedAccountId, connectedAccount.id))
    .orderBy(desc(job.createdAt))
    .limit(limit);
  return rows.map(mapRow);
}
