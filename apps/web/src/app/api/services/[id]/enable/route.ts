import { NextResponse } from "next/server";
import { getService, reenableConnector } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Clear a connector's auto-disable. The health monitor switches a connector off after repeated
 * failures (Principle I), which is right — but without a way back on, a service stays dead even
 * once the cause is fixed. Runs before this point stop counting towards the failure rate, so the
 * connector gets a genuine fresh start rather than being disabled again on its next run.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const { db } = getDb();
  if (!(await getService(db, params.id))) {
    return jsonError("NOT_FOUND", "Unknown service.", 404);
  }
  await reenableConnector(db, params.id);
  return NextResponse.json({ ok: true, serviceId: params.id, disabled: false });
}
