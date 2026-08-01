import { cookies } from "next/headers";
import { getMasterKeyB64 } from "./context";
import { SESSION_COOKIE, createSessionToken, verifySessionToken } from "./session";

const MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * Whether the session cookie may carry the `Secure` attribute.
 *
 * Deliberately not `NODE_ENV === "production"`, which is what this was until it locked an
 * operator out: the published image always runs with `NODE_ENV=production`, and a self-hosted
 * deployment is normally reached over plain HTTP at a LAN address. Browsers silently discard a
 * `Secure` cookie on such an origin, so signing in returned 200, dropped the session on the
 * floor and bounced straight back to the login form with no error to show for it. It only ever
 * appeared to work on localhost, which browsers treat as a secure context.
 *
 * Derived from the request instead, so the attribute is set exactly when the connection can
 * carry it — including behind a reverse proxy that terminates TLS and forwards over HTTP.
 * `SESSION_COOKIE_SECURE=true|false` forces it either way.
 */
export function isSecureRequest(req: Request): boolean {
  const override = process.env.SESSION_COOKIE_SECURE;
  if (override === "true") return true;
  if (override === "false") return false;

  // A proxy that terminates TLS reports the original scheme here; it may list several hops.
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase() === "https";

  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Issue a fresh admin session cookie (HttpOnly, SameSite=Strict). */
export function startSession(req: Request): void {
  const token = createSessionToken(getMasterKeyB64(), { iat: Date.now() });
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(req),
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export function endSession(): void {
  cookies().delete(SESSION_COOKIE);
}

/** True if the current request carries a valid, unexpired session cookie. */
export function isAuthenticated(): boolean {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return verifySessionToken(getMasterKeyB64(), token) !== null;
}

/** Thrown by requireAuth when there is no valid session. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("authentication required");
    this.name = "UnauthenticatedError";
  }
}

/** Guard for API routes; throws UnauthenticatedError when unauthenticated. */
export function requireAuth(): void {
  if (!isAuthenticated()) throw new UnauthenticatedError();
}
