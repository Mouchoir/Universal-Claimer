import { NextResponse } from "next/server";
import { activitySummary, claimsPerDay, listClaimedItems, listJobHistory } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Everything the activity page shows: per-service rollups, the run history and the list of items
 * actually obtained. `?service=<id>` narrows the two lists (the rollups stay global so the filter
 * chips can always be rendered).
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const { db } = getDb();
  const serviceId = new URL(req.url).searchParams.get("service") ?? undefined;

  const [summary, jobs, claims, perDay] = await Promise.all([
    activitySummary(db),
    listJobHistory(db, { serviceId, limit: 100 }),
    listClaimedItems(db, { serviceId, limit: 200 }),
    claimsPerDay(db, 30),
  ]);

  return NextResponse.json({ summary, jobs, claims, perDay });
}
