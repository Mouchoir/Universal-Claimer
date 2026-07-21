import { NextResponse } from "next/server";
import { getDb } from "@/server/context";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness/readiness probe (for the Docker healthcheck + monitoring).
 * Returns DB reachability; 200 when the database answers, 503 otherwise.
 */
export async function GET(): Promise<NextResponse> {
  let db = false;
  try {
    await getDb().pool.query("SELECT 1");
    db = true;
  } catch {
    db = false;
  }
  return NextResponse.json({ ok: true, db }, { status: db ? 200 : 503 });
}
