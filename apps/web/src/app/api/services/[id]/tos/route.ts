import { NextResponse } from "next/server";
import { defaultRegistry } from "@uc/connectors";
import { getAccountByService, getService, hasConsent } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const service = await getService(getDb().db, params.id);
  if (!service) return jsonError("NOT_FOUND", "Unknown service.", 404);
  const configFields = defaultRegistry().get(service.id)?.configFields ?? [];
  const { db } = getDb();
  const account = await getAccountByService(db, service.id);
  return NextResponse.json({
    serviceId: service.id,
    warning: service.tosWarning,
    configFields,
    // Lets the connect page skip the consent step when it was already accepted, and present
    // itself as a reconnect when an account already exists (e.g. after a session expired).
    consented: await hasConsent(db, service.id),
    hasAccount: account !== null,
    existingConfig: account?.config ?? {},
  });
}
