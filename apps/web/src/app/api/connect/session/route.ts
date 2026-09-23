import { NextResponse } from "next/server";
import { createLogger, sealSecret } from "@uc/core";
import { checkSession, defaultFingerprint, parseCookiesTxt } from "@uc/connectors";
import {
  createAccount,
  getAccountByService,
  reenableConnector,
  replaceAccountSecret,
} from "@uc/db";
import { getDb, getMasterKey } from "@/server/context";
import { jsonError } from "@/server/http";
import { redeemPairing, settlePairing } from "@/server/pairing";
import { rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

// This endpoint had no trace of any kind, which made "I clicked and nothing happened"
// undiagnosable from the instance side: a request that never arrived and one that was rejected
// looked identical, namely like silence. Every attempt now says what became of it.
const log = createLogger({ name: "connect-session" });

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
    log.warn("rejected: malformed body", {
      hasToken: Boolean(token),
      hasCookies: Boolean(cookiesText),
    });
    return fail("INVALID_INPUT", "token and cookiesText are required.", 400);
  }

  // Spends the token whatever happens next: a token that survives a malformed body is a token
  // that can be retried against.
  const pairing = redeemPairing(token);
  if (!pairing) {
    log.warn("rejected: pairing expired or already used");
    return fail("PAIRING_INVALID", "This pairing has expired or was already used.", 401);
  }
  const { serviceId, config } = pairing;

  // From here on the page that minted the pairing is waiting on its outcome, so every way out
  // records one. A refusal the page cannot see is a refusal that reads as "nothing happened".
  const refuse = (code: string, message: string, status: number) => {
    settlePairing(token, { state: "failed", error: { code, message } });
    return fail(code, message, status);
  };

  let cookies;
  try {
    cookies = parseCookiesTxt(cookiesText);
  } catch {
    log.warn("rejected: unparseable cookies", { serviceId });
    return refuse("AUTH_FAILED", "Could not parse the provided cookies.", 422);
  }
  if (cookies.length === 0) {
    log.warn("rejected: no usable cookies in the payload", { serviceId });
    return refuse("AUTH_FAILED", "No valid cookies were provided.", 422);
  }

  // Which hosts the session actually covers. Names only — never values. This is what would have
  // shown at a glance that a Prime Gaming export carried no amazon.fr cookies at all.
  const hosts = [...new Set(cookies.map((c) => c.domain.replace(/^\./, "")))].sort();
  // Whether it carries a sign-in at all, by cookie name. Both of the reconnects that looked fine
  // and failed at the next run would have shown here.
  const check = checkSession(serviceId, cookies);
  // `count`, not `cookies`: the logger redacts any key that mentions cookies, which is right for
  // values and had been hiding this number since the line was added.
  log.info("session received", {
    serviceId,
    count: cookies.length,
    hosts,
    signInNames: check.signInNames,
    ...(check.signedInOn ? { signedInOn: check.signedInOn } : {}),
    warnings: check.warnings.length,
  });

  try {
    const { db } = getDb();
    const sealed = sealSecret(JSON.stringify({ cookies }), getMasterKey());
    const secret = {
      method: "session_import" as const,
      secretCiphertext: sealed.ciphertext,
      secretDataKey: sealed.wrappedDataKey,
      // Whatever the operator filled in on the page when the pairing was minted.
      config,
    };

    const existing = await getAccountByService(db, serviceId);
    if (existing) {
      // Only the session is replaced. The proxy and browser fingerprint are left as they were:
      // this path has no way to ask for a proxy, so writing one here could only ever erase it.
      await replaceAccountSecret(db, existing.id, secret);
      // The usual reason a connector auto-disabled is the session just replaced.
      await reenableConnector(db, serviceId);
    } else {
      await createAccount(db, {
        serviceId,
        ...secret,
        fingerprint: defaultFingerprint(),
        proxyCiphertext: null,
        proxyDataKey: null,
      });
    }

    const reconnected = Boolean(existing);
    settlePairing(token, {
      state: "connected",
      reconnected,
      cookieCount: cookies.length,
      hosts,
      ...(check.signedInOn ? { signedInOn: check.signedInOn } : {}),
      ...(check.warnings.length ? { warnings: check.warnings } : {}),
    });
    log.info("session stored", { serviceId, reconnected });
    const res = NextResponse.json(
      { ok: true, serviceId, reconnected },
      { status: reconnected ? 200 : 201 },
    );
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  } catch (err) {
    // Without this a database hiccup was a bare 500 with no CORS headers — which the extension
    // reports as a network error — and no line in the log to say it happened.
    log.error("could not store the session", {
      serviceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return refuse("INTERNAL", "The instance could not save the session. Check its logs.", 500);
  }
}
