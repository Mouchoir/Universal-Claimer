import { NextResponse } from "next/server";
import { verifyLogin } from "@/server/admin-service";
import { getAdminStore } from "@/server/context";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { loginSchema } from "@/server/schemas";
import { startSession } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!rateLimit("login", 10, 5 * 60 * 1000)) {
    return jsonError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
  }
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Password required", 400);

  if (!(await verifyLogin(getAdminStore(), parsed.data.password))) {
    return jsonError("INVALID_CREDENTIALS", "Incorrect password.", 401);
  }
  startSession(req);
  return NextResponse.json({ ok: true });
}
