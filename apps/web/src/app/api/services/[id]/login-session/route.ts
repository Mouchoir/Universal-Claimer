import { NextResponse } from "next/server";
import { isValidProxyUrl, sealSecret } from "@uc/core";
import { defaultRegistry } from "@uc/connectors";
import {
  LOGIN_QUEUE,
  createLoginSession,
  getAccountByService,
  getService,
  hasConsent,
  loginSendOptions,
} from "@uc/db";
import { getDb, getMasterKey, getQueue } from "@/server/context";
import { jsonError } from "@/server/http";
import { missingConfigKeys } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** Start an assisted-login session: the worker opens the service login page in a controlled
 * browser and captures the cookies once the operator logs in. Requires prior consent. */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const body = (await req.json().catch(() => ({}))) as {
    config?: Record<string, string>;
    proxy?: string;
  };
  const config = body.config ?? {};

  const { db } = getDb();
  const service = await getService(db, params.id);
  if (!service) return jsonError("NOT_FOUND", "Unknown service.", 404);
  if (!(await hasConsent(db, service.id))) {
    return jsonError("CONSENT_REQUIRED", "You must consent before connecting.", 400);
  }
  if (await getAccountByService(db, service.id)) {
    return jsonError("ACCOUNT_EXISTS", "This service already has a connected account.", 409);
  }
  const missing = missingConfigKeys(defaultRegistry().get(service.id)?.configFields, config);
  if (missing.length > 0) {
    return jsonError("CONFIG_REQUIRED", `Missing required config: ${missing.join(", ")}`, 400);
  }

  let proxySeal: { ciphertext: Buffer; wrappedDataKey: Buffer } | null = null;
  if (body.proxy && body.proxy.trim()) {
    if (!isValidProxyUrl(body.proxy.trim())) {
      return jsonError("INVALID_PROXY", "Proxy must be http(s)/socks with host and port.", 400);
    }
    proxySeal = sealSecret(body.proxy.trim(), getMasterKey());
  }

  const sessionId = await createLoginSession(db, service.id, {
    config,
    proxyCiphertext: proxySeal?.ciphertext ?? null,
    proxyDataKey: proxySeal?.wrappedDataKey ?? null,
  });
  const boss = await getQueue();
  await boss.send(LOGIN_QUEUE, { sessionId, serviceId: service.id }, loginSendOptions(sessionId));

  return NextResponse.json({ sessionId }, { status: 202 });
}
