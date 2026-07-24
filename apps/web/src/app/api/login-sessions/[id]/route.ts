import { NextResponse } from "next/server";
import { getLoginSession } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const session = await getLoginSession(getDb().db, params.id);
  if (!session) return jsonError("NOT_FOUND", "Unknown login session.", 404);
  // Deployment mode: with a native browser window (default) the operator logs in there and
  // the dashboard only shows instructions. Headless deployments set LOGIN_RELAY_EMBED=true to
  // relay the login page into the dashboard instead (no native window available).
  const embedRelay = process.env.LOGIN_RELAY_EMBED === "true";
  return NextResponse.json({ ...session, embedRelay });
}
