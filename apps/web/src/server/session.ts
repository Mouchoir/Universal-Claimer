import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed session token for the single admin. An HMAC over the payload, keyed by a
 * value derived from APP_ENCRYPTION_KEY, is stored in an HttpOnly cookie. No server-side
 * session store is needed for a single-user deployment.
 */

export const SESSION_COOKIE = "uc_session";
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  /** Issued-at, epoch milliseconds. */
  iat: number;
}

function signingKey(masterKeyB64: string): Buffer {
  return createHash("sha256").update(`uc-session:${masterKeyB64}`).digest();
}

export function createSessionToken(masterKeyB64: string, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", signingKey(masterKeyB64)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(
  masterKeyB64: string,
  token: string | undefined,
  opts: { maxAgeMs?: number; now?: number } = {},
): SessionPayload | null {
  if (!token) return null;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = opts.now ?? Date.now();

  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac("sha256", signingKey(masterKeyB64)).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.iat !== "number") return null;
    if (now - payload.iat > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}
