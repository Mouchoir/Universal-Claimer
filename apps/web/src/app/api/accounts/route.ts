import { NextResponse } from "next/server";
import { isValidProxyUrl, sealSecret } from "@uc/core";
import {
  defaultFingerprint,
  defaultRegistry,
  parseCookiesJson,
  parseCookiesTxt,
} from "@uc/connectors";
import {
  createAccount,
  getAccountByService,
  getService,
  hasConsent,
  listAccounts,
  type ConnectionMethod,
} from "@uc/db";
import { getDb, getMasterKey } from "@/server/context";
import { jsonError } from "@/server/http";
import { connectAccountSchema, missingConfigKeys } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const accounts = await listAccounts(getDb().db);
  // Only non-secret fields are returned (FR-008).
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      serviceId: a.serviceId,
      method: a.method,
      status: a.status,
    })),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const parsed = connectAccountSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input", 400);
  }
  const input = parsed.data;
  const { db } = getDb();

  const service = await getService(db, input.serviceId);
  if (!service) return jsonError("NOT_FOUND", "Unknown service.", 404);
  if (!service.methods.includes(input.method)) {
    return jsonError("METHOD_NOT_SUPPORTED", "This service does not support that method.", 400);
  }
  if (!(await hasConsent(db, service.id))) {
    return jsonError("CONSENT_REQUIRED", "You must consent before connecting.", 400);
  }
  if (await getAccountByService(db, service.id)) {
    return jsonError("ACCOUNT_EXISTS", "This service already has a connected account.", 409);
  }

  const configFields = defaultRegistry().get(service.id)?.configFields;
  const missing = missingConfigKeys(configFields, input.config);
  if (missing.length > 0) {
    return jsonError("CONFIG_REQUIRED", `Missing required config: ${missing.join(", ")}`, 400);
  }

  // Build the secret payload from the chosen method.
  let payload: string;
  if (input.method === "session_import") {
    let cookies;
    try {
      cookies = input.cookiesText
        ? parseCookiesTxt(input.cookiesText)
        : input.cookiesJson
          ? parseCookiesJson(input.cookiesJson)
          : [];
    } catch {
      return jsonError("AUTH_FAILED", "Could not parse the provided cookies.", 422);
    }
    if (cookies.length === 0) {
      return jsonError("AUTH_FAILED", "No valid cookies were provided.", 422);
    }
    payload = JSON.stringify({ cookies });
  } else {
    payload = JSON.stringify({
      email: input.email,
      password: input.password,
      totpSeed: input.totpSeed,
    });
  }

  // Optional per-account proxy (sealed like the secret).
  let proxySeal: { ciphertext: Buffer; wrappedDataKey: Buffer } | null = null;
  if (input.proxy && input.proxy.trim()) {
    if (!isValidProxyUrl(input.proxy.trim())) {
      return jsonError("INVALID_PROXY", "Proxy must be http(s)/socks with host and port.", 400);
    }
    proxySeal = sealSecret(input.proxy.trim(), getMasterKey());
  }

  const sealed = sealSecret(payload, getMasterKey());
  const account = await createAccount(db, {
    serviceId: service.id,
    method: input.method as ConnectionMethod,
    secretCiphertext: sealed.ciphertext,
    secretDataKey: sealed.wrappedDataKey,
    fingerprint: defaultFingerprint(),
    config: input.config ?? {},
    proxyCiphertext: proxySeal?.ciphertext ?? null,
    proxyDataKey: proxySeal?.wrappedDataKey ?? null,
  });

  return NextResponse.json({ accountId: account.id, status: account.status }, { status: 201 });
}
