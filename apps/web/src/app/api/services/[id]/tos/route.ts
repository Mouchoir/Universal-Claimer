import { NextResponse } from "next/server";
import { getService } from "@uc/db";
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
  return NextResponse.json({ serviceId: service.id, warning: service.tosWarning });
}
