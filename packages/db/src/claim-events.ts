import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { claimEvent } from "./schema.js";

/**
 * Structured history of what each claim actually obtained (docs/design/account-insights.md).
 * Recorded per item so the dashboard can list recent claims and compute stats without parsing
 * a job's free-text summary.
 */

export type ClaimKind = "game" | "prime_sub" | "points";

export interface ClaimEventRow {
  id: string;
  connectedAccountId: string;
  serviceId: string;
  jobId: string | null;
  kind: ClaimKind;
  title: string;
  claimedAt: Date;
  /** Store the key must be redeemed on (GOG, Epic Games Store, …), when it is not in-place. */
  platform: string | null;
  /** Deadline to redeem; keys stop working when the offer ends. */
  redeemBy: Date | null;
  /** True when a redemption key was captured (the key itself is never returned here). */
  hasCode: boolean;
  redeemedAt: Date | null;
}

export interface NewClaimEvent {
  connectedAccountId: string;
  serviceId: string;
  jobId?: string | null;
  kind: ClaimKind;
  title: string;
  platform?: string | null;
  redeemBy?: Date | null;
  /** Sealed redemption key (envelope-encrypted by the caller). */
  codeCiphertext?: Buffer | null;
  codeDataKey?: Buffer | null;
}

/** Record the items obtained by one claim. No-op for an empty list. */
export async function recordClaimEvents(
  db: Database,
  events: NewClaimEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db.insert(claimEvent).values(
    events.map((e) => ({
      connectedAccountId: e.connectedAccountId,
      serviceId: e.serviceId,
      jobId: e.jobId ?? null,
      kind: e.kind,
      title: e.title,
      platform: e.platform ?? null,
      redeemBy: e.redeemBy ?? null,
      codeCiphertext: e.codeCiphertext ?? null,
      codeDataKey: e.codeDataKey ?? null,
    })),
  );
}

/** Most recent claims, newest first. Optionally scoped to one account. */
export async function listClaimEvents(
  db: Database,
  opts: { accountId?: string; limit?: number } = {},
): Promise<ClaimEventRow[]> {
  const limit = opts.limit ?? 50;
  const base = db.select().from(claimEvent);
  const rows = await (opts.accountId
    ? base.where(eq(claimEvent.connectedAccountId, opts.accountId))
    : base
  )
    .orderBy(desc(claimEvent.claimedAt))
    .limit(limit);
  return rows.map(toRow);
}

export interface ClaimStats {
  /** Total items claimed, all services. */
  total: number;
  /** Items claimed per service id. */
  byService: Record<string, number>;
}

/** Aggregate counts for the dashboard's stat cards. */
export async function claimStats(db: Database): Promise<ClaimStats> {
  const rows = await db
    .select({ serviceId: claimEvent.serviceId, count: sql<number>`count(*)::int` })
    .from(claimEvent)
    .groupBy(claimEvent.serviceId);
  const byService: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byService[r.serviceId] = Number(r.count);
    total += Number(r.count);
  }
  return { total, byService };
}

function toRow(row: typeof claimEvent.$inferSelect): ClaimEventRow {
  return {
    id: row.id,
    connectedAccountId: row.connectedAccountId,
    serviceId: row.serviceId,
    jobId: row.jobId ?? null,
    kind: row.kind as ClaimKind,
    title: row.title,
    claimedAt: row.claimedAt,
    platform: row.platform ?? null,
    redeemBy: row.redeemBy ?? null,
    // Only whether a key exists — the key itself stays sealed until explicitly requested.
    hasCode: row.codeCiphertext !== null,
    redeemedAt: row.redeemedAt ?? null,
  };
}
