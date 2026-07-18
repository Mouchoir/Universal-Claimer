import { NextResponse } from "next/server";
import { getJob } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const job = await getJob(getDb().db, params.id);
  if (!job) return jsonError("NOT_FOUND", "Unknown job.", 404);
  return NextResponse.json(job);
}
