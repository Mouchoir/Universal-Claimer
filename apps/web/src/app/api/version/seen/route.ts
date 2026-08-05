import { NextResponse } from "next/server";
import { LAST_SEEN_VERSION, setSetting } from "@uc/db";
import { getDb } from "@/server/context";
import { requireAuth } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Mark the running version's notes as read.
 *
 * Recorded in the database rather than the browser, so the note does not reappear on a different
 * machine — and, more to the point, so it does appear exactly once rather than once per browser.
 */
export async function POST(): Promise<NextResponse> {
  requireAuth();
  await setSetting(getDb().db, LAST_SEEN_VERSION, process.env.APP_VERSION ?? "dev");
  return NextResponse.json({ ok: true });
}
