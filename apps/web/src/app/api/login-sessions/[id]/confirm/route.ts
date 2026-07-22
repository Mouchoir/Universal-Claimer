import { NextResponse } from "next/server";
import { confirmLoginSession, getLoginSession } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** The operator signals they have finished logging in; the worker then captures the session. */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const { db } = getDb();
  const session = await getLoginSession(db, params.id);
  if (!session) return jsonError("NOT_FOUND", "Unknown login session.", 404);
  if (session.status !== "awaiting_user") {
    return jsonError("NOT_WAITING", "This session is not awaiting login.", 409);
  }
  await confirmLoginSession(db, params.id);
  return NextResponse.json({ ok: true });
}
