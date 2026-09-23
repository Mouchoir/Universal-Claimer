import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { pairingStatus } from "@/server/pairing";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Where a pairing stands, for the page that minted it.
 *
 * This is what the page waits on. It used to wait on "an account exists for this service", which
 * is true from the first second of any reconnect — so it declared success before the extension had
 * sent anything, and navigated away with the pairing URL the extension needed.
 *
 * Authenticated, and deliberately without CORS: only the operator's own page reads this. The id is
 * a one-way derivative of the token, and the answer carries cookie counts and host names, never
 * cookie values or the token.
 */
export function GET(_req: Request, { params }: { params: { id: string } }): NextResponse {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const status = pairingStatus(params.id);
  const res = status
    ? NextResponse.json(status)
    : // Most often the instance restarted since the pairing was minted: the store is in memory.
      NextResponse.json({ state: "unknown" }, { status: 404 });
  res.headers.set("cache-control", "no-store");
  return res;
}
