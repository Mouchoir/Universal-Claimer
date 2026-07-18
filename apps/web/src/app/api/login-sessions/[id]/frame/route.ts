import { NextResponse } from "next/server";
import { getLoginFrame } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** Serves the latest screenshot frame of a login session as a PNG (headless relay). */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const frame = await getLoginFrame(getDb().db, params.id);
  if (!frame) return new Response("no frame yet", { status: 204 });
  return new Response(new Uint8Array(frame), {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
