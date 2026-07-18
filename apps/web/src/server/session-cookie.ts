import { cookies } from "next/headers";
import { getMasterKeyB64 } from "./context";
import { SESSION_COOKIE, createSessionToken, verifySessionToken } from "./session";

const MAX_AGE_SEC = 7 * 24 * 60 * 60;

/** Issue a fresh admin session cookie (HttpOnly, SameSite=Strict). */
export function startSession(): void {
  const token = createSessionToken(getMasterKeyB64(), { iat: Date.now() });
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
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
