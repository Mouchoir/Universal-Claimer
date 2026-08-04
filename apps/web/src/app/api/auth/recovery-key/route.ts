import { NextResponse } from "next/server";
import { verifyLogin } from "@/server/admin-service";
import { getAdminStore } from "@/server/context";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { requireAuth } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Reveal the deployment's encryption key so the operator can archive it.
 *
 * The key is generated on first boot and kept on a volume, which means it exists nowhere the
 * operator can see. That is fine until the volume is lost — at which point the database is
 * intact and permanently unreadable, and there is nothing to restore from. This is the escape
 * hatch: copy the key somewhere durable while everything still works.
 *
 * Gated on the admin password rather than the session alone. A session cookie is enough to run
 * claims; handing over the key that decrypts every stored account is worth re-proving who is
 * asking, and it is the one value in the system that is equivalent to all the others combined.
 */
export async function POST(req: Request): Promise<NextResponse> {
  requireAuth();
  if (!rateLimit("recovery-key", 5, 5 * 60 * 1000)) {
    return jsonError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
  }

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) return jsonError("INVALID_INPUT", "Password required.", 400);

  if (!(await verifyLogin(getAdminStore(), password))) {
    return jsonError("INVALID_CREDENTIALS", "Incorrect password.", 401);
  }

  // Read straight from the environment rather than through getMasterKey(), which returns the
  // decoded buffer; what the operator needs to store is the base64 form they would paste back.
  const key = process.env.APP_ENCRYPTION_KEY ?? "";
  if (!key) return jsonError("NOT_AVAILABLE", "No encryption key is configured.", 500);

  return NextResponse.json({ key });
}
