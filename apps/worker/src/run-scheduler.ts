import type { ScheduleRow } from "@uc/db";

/**
 * Scheduler tick: enqueue a claim for every due schedule (skipping accounts that already have
 * an active claim, FR-005), and advance each due schedule to its next occurrence — always, so
 * an overdue schedule fires at most once and does not build a backlog (FR-007). Dependencies
 * are injected so the logic is unit-testable without a DB or queue.
 */
export interface SchedulerDeps {
  now(): Date;
  listDue(now: Date): Promise<ScheduleRow[]>;
  hasActiveJob(connectedAccountId: string): Promise<boolean>;
  /** Enqueue a claim (with a small startAfter jitter). Returns false if the account is gone. */
  enqueueClaim(connectedAccountId: string): Promise<boolean>;
  /** Advance the schedule to its next occurrence (compute next + persist). */
  advance(schedule: ScheduleRow, now: Date): Promise<void>;
}

export async function runScheduler(deps: SchedulerDeps): Promise<number> {
  const now = deps.now();
  const due = await deps.listDue(now);
  let dispatched = 0;

  for (const s of due) {
    if (s.enabled && !(await deps.hasActiveJob(s.connectedAccountId))) {
      const ok = await deps.enqueueClaim(s.connectedAccountId);
      if (ok) dispatched += 1;
    }
    // Advance regardless: a skipped or disabled-in-flight occurrence still passes.
    await deps.advance(s, now);
  }
  return dispatched;
}
