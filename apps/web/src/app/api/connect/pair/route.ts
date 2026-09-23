import { NextResponse } from "next/server";
import { defaultRegistry } from "@uc/connectors";
import { getService, hasConsent } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { mintPairing, pairingIdFor } from "@/server/pairing";
import { rateLimit } from "@/server/rate-limit";
import { missingConfigKeys } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Mint a pairing token so the browser extension can hand this instance a session directly.
 *
 * Authenticated, because this is where the authority comes from: the operator is signed in on a
 * page they opened, and the token carries a slice of that for a few minutes. The extension itself
 * never authenticates — asking for the admin password inside a popup is the habit worth avoiding.
 *
 * Consent is checked here rather than at redemption so the refusal lands on the page the operator
 * is looking at, instead of inside an extension popup that cannot explain it.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // A 401 the page can explain, rather than requireAuth's throw — which Next turns into a bare 500
  // that the page could only report as "could not start the pairing".
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  if (!rateLimit("pair", 20, 5 * 60 * 1000)) {
    return jsonError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
  }

  const body = (await req.json().catch(() => null)) as {
    serviceId?: unknown;
    config?: unknown;
  } | null;
  const serviceId = typeof body?.serviceId === "string" ? body.serviceId : "";
  if (!serviceId) return jsonError("INVALID_INPUT", "serviceId is required.", 400);

  const config: Record<string, string> = {};
  if (body?.config && typeof body.config === "object") {
    for (const [k, v] of Object.entries(body.config as Record<string, unknown>)) {
      if (typeof v === "string") config[k] = v;
    }
  }

  const { db } = getDb();
  const service = await getService(db, serviceId);
  if (!service) return jsonError("NOT_FOUND", "Unknown service.", 404);
  if (!(await hasConsent(db, service.id))) {
    return jsonError("CONSENT_REQUIRED", "You must consent before connecting.", 400);
  }

  // Checked before minting so a missing channel is reported on the page the operator is looking
  // at, rather than surfacing as a connected-but-unusable account after the popup says "done".
  const missing = missingConfigKeys(defaultRegistry().get(service.id)?.configFields, config);
  if (missing.length > 0) {
    return jsonError("CONFIG_REQUIRED", `Missing required config: ${missing.join(", ")}`, 400);
  }

  const token = mintPairing(service.id, config);
  // The id is what the page polls for the outcome. It is derived from the token one-way, so it can
  // sit in a URL without being able to redeem anything.
  return NextResponse.json({ token, pairingId: pairingIdFor(token) });
}
