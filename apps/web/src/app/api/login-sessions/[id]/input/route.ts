import { NextResponse } from "next/server";
import { enqueueInput, getLoginSession, type InputKind } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { loginInputSchema } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** Relay an operator input event (click/type/key/scroll) to the worker's login browser. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const parsed = loginInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Invalid input event", 400);

  const { db } = getDb();
  const session = await getLoginSession(db, params.id);
  if (!session) return jsonError("NOT_FOUND", "Unknown login session.", 404);
  if (session.status !== "awaiting_user") {
    return jsonError("NOT_ACCEPTING_INPUT", "This session is not accepting input.", 409);
  }

  const { kind, ...payload } = parsed.data;
  await enqueueInput(db, params.id, { kind: kind as InputKind, payload });
  return NextResponse.json({ ok: true });
}
