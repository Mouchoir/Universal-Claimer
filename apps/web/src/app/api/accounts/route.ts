import { NextResponse } from "next/server";
import { estimateBenefitEnd, isValidProxyUrl, sealSecret } from "@uc/core";
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
  listClaimEvents,
  reenableConnector,
  replaceAccountSecret,
  type ConnectionMethod,
  type Entitlement,
} from "@uc/db";
import { getDb, getMasterKey } from "@/server/context";
import { jsonError } from "@/server/http";
import { connectAccountSchema, missingConfigKeys } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Fill in a missing entitlement end date from our own claim history. Twitch stopped exposing a
 * subscription's end date anywhere scrapable, so when the service doesn't tell us we estimate it
 * from when *we* claimed the benefit. Flagged `endsAtEstimated` so the UI can label it as such;
 * a real date reported by the connector always wins.
 */
function withEstimatedEnd(
  entitlements: Entitlement[] | undefined,
  claims: { kind: string; title: string; claimedAt: Date }[],
): (Entitlement & { endsAtEstimated?: boolean })[] | undefined {
  if (!entitlements?.length) return entitlements;
  return entitlements.map((e) => {
    if (e.endsAt || e.kind !== "prime_sub") return e;
    const last = claims.find(
      (c) => c.kind === "prime_sub" && (!e.channel || c.title.toLowerCase() === e.channel.toLowerCase()),
    );
    if (!last) return e;
    return {
      ...e,
      endsAt: estimateBenefitEnd(new Date(last.claimedAt)).toISOString(),
      endsAtEstimated: true,
    };
  });
}

export async function GET(): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const { db } = getDb();
  const accounts = await listAccounts(db);
  // Only non-secret fields are returned (FR-008). displayName/facts are non-secret observations
  // (the account's own username, active entitlements) surfaced in the dashboard.
  return NextResponse.json({
    accounts: await Promise.all(
      accounts.map(async (a) => {
        const claims = await listClaimEvents(db, { accountId: a.id, limit: 20 });
        return {
          id: a.id,
          serviceId: a.serviceId,
          method: a.method,
          status: a.status,
          displayName: a.displayName,
          schedulingMode: defaultRegistry().get(a.serviceId)?.schedulingMode ?? "recurring",
          config: a.config,
          facts: { ...a.facts, entitlements: withEstimatedEnd(a.facts.entitlements, claims) },
          factsUpdatedAt: a.factsUpdatedAt,
          recentClaims: claims.slice(0, 5).map((c) => ({
            kind: c.kind,
            title: c.title,
            claimedAt: c.claimedAt,
          })),
        };
      }),
    ),
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
  // An existing account for this service is replaced rather than rejected: reaching this page for
  // a connected service means "reconnect it" (typically after the session expired). The account
  // id, claim history and schedule are preserved.
  const existing = await getAccountByService(db, service.id);

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
  const values = {
    method: input.method as ConnectionMethod,
    secretCiphertext: sealed.ciphertext,
    secretDataKey: sealed.wrappedDataKey,
    fingerprint: defaultFingerprint(),
    config: input.config ?? {},
    proxyCiphertext: proxySeal?.ciphertext ?? null,
    proxyDataKey: proxySeal?.wrappedDataKey ?? null,
  };

  if (existing) {
    await replaceAccountSecret(db, existing.id, values);
    // The usual reason a connector auto-disabled is the session that just got replaced, so
    // clear the flag rather than leaving the operator with a dead, unrunnable service.
    await reenableConnector(db, service.id);
    return NextResponse.json({ accountId: existing.id, status: "connected", reconnected: true });
  }

  const account = await createAccount(db, { serviceId: service.id, ...values });
  return NextResponse.json({ accountId: account.id, status: account.status }, { status: 201 });
}
