import { NextResponse } from "next/server";
import {
  LOGIN_QUEUE,
  createLoginSession,
  getAccountByService,
  getService,
  hasConsent,
  loginSendOptions,
} from "@uc/db";
import { getDb, getQueue } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** Start an assisted-login session: the worker opens the service login page in a controlled
 * browser and captures the cookies once the operator logs in. Requires prior consent. */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const { db } = getDb();
  const service = await getService(db, params.id);
  if (!service) return jsonError("NOT_FOUND", "Unknown service.", 404);
  if (!(await hasConsent(db, service.id))) {
    return jsonError("CONSENT_REQUIRED", "You must consent before connecting.", 400);
  }
  if (await getAccountByService(db, service.id)) {
    return jsonError("ACCOUNT_EXISTS", "This service already has a connected account.", 409);
  }

  const sessionId = await createLoginSession(db, service.id);
  const boss = await getQueue();
  await boss.send(LOGIN_QUEUE, { sessionId, serviceId: service.id }, loginSendOptions(sessionId));

  return NextResponse.json({ sessionId }, { status: 202 });
}
