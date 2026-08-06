import { NextResponse } from "next/server";
import { sealSecret } from "@uc/core";
import { defaultFingerprint, parseCookiesTxt } from "@uc/connectors";
import {
  createAccount,
  getAccountByService,
  reenableConnector,
  replaceAccountSecret,
} from "@uc/db";
import { getDb, getMasterKey } from "@/server/context";
import { jsonError } from "@/server/http";
import { redeemPairing } from "@/server/pairing";
import { rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Receive a session exported by the browser extension.
 *
 * Unauthenticated by necessity: the request comes from an extension popup, which has no session
 * here and should not be asking for one. The pairing token is the authorisation — minted seconds
 * earlier from a page the operator was signed in to, valid for one service, one POST, ten minutes.
 *
 * The extension has no host permission for this instance (its address is unknowable at build
 * time), so its fetch is an ordinary cross-origin request and needs CORS. `*` is correct here
 * precisely because the token is the secret rather than the origin: an attacker who could reach
 * this endpoint still needs a token they have no way to obtain, and there are no credentials on
 * the request for a hostile page to ride.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
} as const;

const fail = (code: string, message: string, status: number) => {
  const res = jsonError(code, message, status);
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Tighter than the other limits: nothing legitimate calls this more than once per pairing, and
  // it is the one unauthenticated write in the app.
  if (!rateLimit("connect-session", 10, 5 * 60 * 1000)) {
    return fail("RATE_LIMITED", "Too many attempts. Try again later.", 429);
  }

  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    cookiesText?: unknown;
  } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  const cookiesText = typeof body?.cookiesText === "string" ? body.cookiesText : "";
  if (!token || !cookiesText) {
    return fail("INVALID_INPUT", "token and cookiesText are required.", 400);
  }

  // Spends the token whatever happens next: a token that survives a malformed body is a token
  // that can be retried against.
  const pairing = redeemPairing(token);
  if (!pairing) {
    return fail("PAIRING_INVALID", "This pairing has expired or was already used.", 401);
  }
  const { serviceId, config } = pairing;

  let cookies;
  try {
    cookies = parseCookiesTxt(cookiesText);
  } catch {
    return fail("AUTH_FAILED", "Could not parse the provided cookies.", 422);
  }
  if (cookies.length === 0) {
    return fail("AUTH_FAILED", "No valid cookies were provided.", 422);
  }

  const { db } = getDb();
  const sealed = sealSecret(JSON.stringify({ cookies }), getMasterKey());
  const values = {
    method: "session_import" as const,
    secretCiphertext: sealed.ciphertext,
    secretDataKey: sealed.wrappedDataKey,
    fingerprint: defaultFingerprint(),
    // Whatever the operator filled in on the page when the pairing was minted.
    config,
    proxyCiphertext: null,
    proxyDataKey: null,
  };

  const existing = await getAccountByService(db, serviceId);
  if (existing) {
    await replaceAccountSecret(db, existing.id, values);
    // The usual reason a connector auto-disabled is the session just replaced.
    await reenableConnector(db, serviceId);
    const res = NextResponse.json({ ok: true, serviceId, reconnected: true });
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  }

  await createAccount(db, { serviceId, ...values });
  const res = NextResponse.json({ ok: true, serviceId, reconnected: false }, { status: 201 });
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}
