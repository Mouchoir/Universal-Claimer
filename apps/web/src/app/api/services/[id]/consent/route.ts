import { NextResponse } from "next/server";
import { getService, recordConsent } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { consentSchema } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const parsed = consentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("CONSENT_REQUIRED", "Explicit consent is required.", 400);
  }
  const { db } = getDb();
  const service = await getService(db, params.id);
  if (!service) return jsonError("NOT_FOUND", "Unknown service.", 404);

  const acceptedAt = await recordConsent(db, service.id, service.tosWarning);
  return NextResponse.json({ consentedAt: acceptedAt.toISOString() }, { status: 201 });
}
