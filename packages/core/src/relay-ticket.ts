import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, session-scoped ticket authorizing an operator's browser to open the relay
 * WebSocket (docs/design/cdp-relay.md). Minted by an authenticated web route and verified by
 * the custom server on the WS upgrade — so the plain-JS server never has to re-parse the admin
 * session cookie. Signed with a key derived from APP_ENCRYPTION_KEY, like the session token.
 */

const DEFAULT_TTL_MS = 60_000;

function signingKey(masterKeyB64: string): Buffer {
  return createHash("sha256").update(`uc-relay:${masterKeyB64}`).digest();
}

/** Constant-time string comparison for secrets/tokens (avoids length-independent early exit). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function mintRelayTicket(
  masterKeyB64: string,
  sessionId: string,
  opts: { ttlMs?: number; now?: number } = {},
): string {
  const exp = (opts.now ?? Date.now()) + (opts.ttlMs ?? DEFAULT_TTL_MS);
  const body = Buffer.from(JSON.stringify({ sid: sessionId, exp })).toString("base64url");
  const sig = createHmac("sha256", signingKey(masterKeyB64)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verify a ticket and return its session id, or null if invalid/expired/for another session. */
export function verifyRelayTicket(
  masterKeyB64: string,
  ticket: string | undefined,
  sessionId: string,
  opts: { now?: number } = {},
): string | null {
  if (!ticket) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0) return null;
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);

  const expected = createHmac("sha256", signingKey(masterKeyB64)).update(body).digest("base64url");
  if (!constantTimeEqual(sig, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sid?: unknown;
      exp?: unknown;
    };
    if (typeof payload.sid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.sid !== sessionId) return null;
    if ((opts.now ?? Date.now()) > payload.exp) return null;
    return payload.sid;
  } catch {
    return null;
  }
}
