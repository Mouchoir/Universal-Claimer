import { inArray } from "drizzle-orm";
import type { Database } from "@uc/db";
import { job } from "@uc/db";

/**
 * On worker startup, any job left in a non-terminal state by an unexpected shutdown is
 * marked failed/"interrupted" so no job stays permanently "running" (FR-016).
 * Returns the number of jobs reconciled.
 */
export async function reconcileInterruptedJobs(db: Database, now: Date = new Date()): Promise<number> {
  const result = await db
    .update(job)
    .set({
      state: "failed",
      outcome: "failed",
      summary: "interrupted: the worker restarted while this job was in progress",
      finishedAt: now,
    })
    .where(inArray(job.state, ["queued", "running", "requires_human_action"]))
    .returning({ id: job.id });
  return result.length;
}
