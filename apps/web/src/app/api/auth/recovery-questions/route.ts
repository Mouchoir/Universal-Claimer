import { NextResponse } from "next/server";
import { listRecoveryQuestions } from "@/server/admin-service";
import { getAdminStore } from "@/server/context";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The questions shown on the reset form. Unauthenticated by necessity — see
 * listRecoveryQuestions for why that is the accepted trade of this recovery mechanism.
 *
 * Rate-limited anyway: the response reveals whether recovery is configured at all, and there is
 * no reason for a caller to ask more than a handful of times.
 */
export async function GET(): Promise<NextResponse> {
  if (!rateLimit("recovery-questions", 30, 5 * 60 * 1000)) {
    return jsonError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
  }
  const questions = await listRecoveryQuestions(getAdminStore());
  return NextResponse.json({ enabled: questions.length === 3, questions });
}
