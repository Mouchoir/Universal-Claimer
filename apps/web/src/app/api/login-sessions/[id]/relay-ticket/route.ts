import { NextResponse } from "next/server";
import { mintRelayTicket } from "@uc/core";
import { getLoginSession } from "@uc/db";
import { getDb, getMasterKeyB64 } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Mint a short-lived ticket authorizing the operator's browser to open the relay WebSocket for
 * this login session (docs/design/cdp-relay.md). Requires an authenticated admin and a session
 * that is actually awaiting login; the custom server verifies the ticket on the WS upgrade.
 */
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
  const ticket = mintRelayTicket(getMasterKeyB64(), params.id);
  return NextResponse.json({ ticket });
}
