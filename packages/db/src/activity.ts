import { desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { claimEvent, connectedAccount, job, schedule } from "./schema.js";
import type { JobOutcome, JobRow, JobState } from "./jobs.js";

/**
 * Read models for the activity dashboard (docs/design/account-insights.md): what ran, when, how it
 * went, and what it produced. Aggregation happens in SQL so the page stays cheap as history grows.
 */

/** Per-service rollup shown as stat cards. */
export interface ServiceActivity {
  serviceId: string;
  /** Items obtained all-time (games, Prime subs, points sets). */
  claimedTotal: number;
  /** Items obtained in the last 30 days. */
  claimedRecent: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: Date | null;
  lastOutcome: JobOutcome | null;
  nextRunAt: Date | null;
}

export interface ActivitySummary {
  claimedTotal: number;
  claimedRecent: number;
  totalRuns: number;
  successfulRuns: number;
  services: ServiceActivity[];
}

const RECENT_DAYS = 30;

/** A run counts as successful when it reached a terminal state without erroring out. */
// (success is expressed directly in the SQL filters below)

/**
 * Everything the activity page needs in one pass: claim counts, run counts and outcomes per
 * service, plus the last and next run.
 */
export async function activitySummary(db: Database): Promise<ActivitySummary> {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);

  const claims = await db
    .select({
      serviceId: claimEvent.serviceId,
      total: sql<number>`count(*)::int`,
      recent: sql<number>`count(*) filter (where ${claimEvent.claimedAt} >= ${since})::int`,
    })
    .from(claimEvent)
    .groupBy(claimEvent.serviceId);

  // Jobs carry no service id of their own; it comes from the account they belong to.
  const runs = await db
    .select({
      serviceId: connectedAccount.serviceId,
      total: sql<number>`count(*)::int`,
      successful: sql<number>`count(*) filter (where ${job.outcome} in ('claimed','nothing_to_claim'))::int`,
      failed: sql<number>`count(*) filter (where ${job.outcome} in ('failed','reauth_needed'))::int`,
      lastRunAt: sql<Date | null>`max(${job.createdAt})`,
    })
    .from(job)
    .innerJoin(connectedAccount, eq(job.connectedAccountId, connectedAccount.id))
    .groupBy(connectedAccount.serviceId);

  const schedules = await db
    .select({ serviceId: connectedAccount.serviceId, nextRunAt: schedule.nextRunAt })
    .from(schedule)
    .innerJoin(connectedAccount, eq(schedule.connectedAccountId, connectedAccount.id))
    .where(eq(schedule.enabled, true));

  // The most recent outcome per service, for an at-a-glance health read.
  const lastOutcomes = await db
    .select({
      serviceId: connectedAccount.serviceId,
      outcome: job.outcome,
      createdAt: job.createdAt,
    })
    .from(job)
    .innerJoin(connectedAccount, eq(job.connectedAccountId, connectedAccount.id))
    .orderBy(desc(job.createdAt));

  const byService = new Map<string, ServiceActivity>();
  const ensure = (serviceId: string): ServiceActivity => {
    let row = byService.get(serviceId);
    if (!row) {
      row = {
        serviceId,
        claimedTotal: 0,
        claimedRecent: 0,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        lastRunAt: null,
        lastOutcome: null,
        nextRunAt: null,
      };
      byService.set(serviceId, row);
    }
    return row;
  };

  for (const c of claims) {
    const row = ensure(c.serviceId);
    row.claimedTotal = Number(c.total);
    row.claimedRecent = Number(c.recent);
  }
  for (const r of runs) {
    const row = ensure(r.serviceId);
    row.totalRuns = Number(r.total);
    row.successfulRuns = Number(r.successful);
    row.failedRuns = Number(r.failed);
    row.lastRunAt = r.lastRunAt ? new Date(r.lastRunAt) : null;
  }
  for (const s of schedules) {
    if (s.nextRunAt) ensure(s.serviceId).nextRunAt = s.nextRunAt;
  }
  for (const o of lastOutcomes) {
    const row = ensure(o.serviceId);
    // Rows arrive newest-first, so the first one seen per service is the latest.
    if (row.lastOutcome === null && o.outcome) row.lastOutcome = o.outcome as JobOutcome;
  }

  const services = [...byService.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  return {
    claimedTotal: services.reduce((n, s) => n + s.claimedTotal, 0),
    claimedRecent: services.reduce((n, s) => n + s.claimedRecent, 0),
    totalRuns: services.reduce((n, s) => n + s.totalRuns, 0),
    successfulRuns: services.reduce((n, s) => n + s.successfulRuns, 0),
    services,
  };
}

/** Job history, newest first, optionally narrowed to one service. */
export async function listJobHistory(
  db: Database,
  opts: { serviceId?: string; limit?: number } = {},
): Promise<JobRow[]> {
  const rows = await db
    .select({
      id: job.id,
      connectedAccountId: job.connectedAccountId,
      serviceId: connectedAccount.serviceId,
      state: job.state,
      outcome: job.outcome,
      summary: job.summary,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    })
    .from(job)
    .innerJoin(connectedAccount, eq(job.connectedAccountId, connectedAccount.id))
    .where(opts.serviceId ? eq(connectedAccount.serviceId, opts.serviceId) : undefined)
    .orderBy(desc(job.createdAt))
    .limit(opts.limit ?? 100);

  return rows.map((r) => ({
    ...r,
    state: r.state as JobState,
    outcome: (r.outcome as JobOutcome | null) ?? null,
  }));
}

/** Claimed items, newest first, optionally narrowed to one service. */
export async function listClaimedItems(
  db: Database,
  opts: { serviceId?: string; limit?: number } = {},
) {
  return db
    .select()
    .from(claimEvent)
    .where(opts.serviceId ? eq(claimEvent.serviceId, opts.serviceId) : undefined)
    .orderBy(desc(claimEvent.claimedAt))
    .limit(opts.limit ?? 200);
}

/** Claims per day over the last `days`, for a simple trend line. */
export async function claimsPerDay(
  db: Database,
  days = 30,
): Promise<{ day: string; count: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      day: sql<string>`to_char(${claimEvent.claimedAt}, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(claimEvent)
    .where(gte(claimEvent.claimedAt, since))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}


