import { NextResponse } from "next/server";
import {
  AnswersIncorrectError,
  RecoveryDisabledError,
  recoverPassword,
} from "@/server/admin-service";
import { getAdminStore } from "@/server/context";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { recoverSchema } from "@/server/schemas";
import { startSession } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!rateLimit("recover", 10, 5 * 60 * 1000)) {
    return jsonError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
  }
  const parsed = recoverSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Three answers + new password", 400);

  try {
    await recoverPassword(getAdminStore(), parsed.data.answers, parsed.data.newPassword);
  } catch (err) {
    if (err instanceof RecoveryDisabledError) {
      return jsonError("RECOVERY_DISABLED", "Password recovery is not enabled.", 400);
    }
    if (err instanceof AnswersIncorrectError) {
      return jsonError("ANSWERS_INCORRECT", "One or more answers are incorrect.", 401);
    }
    throw err;
  }
  startSession(req);
  return NextResponse.json({ ok: true });
}
