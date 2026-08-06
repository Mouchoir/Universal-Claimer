import { randomBytes } from "node:crypto";

/**
 * Short-lived tokens that let the browser extension hand a session straight to this instance.
 *
 * The extension has no login here and cannot be given one — it would mean asking the operator for
 * their admin password inside a popup, which is exactly the habit a password manager exists to
 * break. So the token is the authorisation: the operator creates one from a page they are already
 * signed in to, and it buys a single POST for a single service within a few minutes.
 *
 * Kept in memory rather than in the database. A pairing lives for minutes and is meaningless
 * afterwards, so persisting it would mostly mean writing rows whose only job is to expire — and
 * losing them on restart is the correct behaviour, not a bug: a restart mid-pairing means the
 * operator starts again, which costs one click.
 */

/** Long enough that guessing is hopeless; the window is minutes and single-use besides. */
const TOKEN_BYTES = 32;
const TTL_MS = 10 * 60 * 1000;
/** A ceiling so a script hammering the mint endpoint cannot grow this without bound. */
const MAX_PENDING = 32;

export interface Pairing {
  serviceId: string;
  /**
   * Per-service settings the operator filled in on the page — Twitch's channel, for instance.
   * Carried by the token because the extension has no way to ask for them: its popup knows about
   * cookies, not about what a given connector needs.
   */
  config: Record<string, string>;
}

interface Entry extends Pairing {
  expiresAt: number;
}

const pending = new Map<string, Entry>();

/** Test seam. */
export function resetPairings(): void {
  pending.clear();
}

function sweep(now: number): void {
  for (const [token, p] of pending) if (p.expiresAt <= now) pending.delete(token);
}

export function mintPairing(
  serviceId: string,
  config: Record<string, string> = {},
  now: number = Date.now(),
): string {
  sweep(now);
  // Oldest-first eviction: the cap exists to bound memory, and the oldest pending pairing is the
  // one the operator is least likely to still be looking at.
  while (pending.size >= MAX_PENDING) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) break;
    pending.delete(oldest[0]);
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  pending.set(token, { serviceId, config, expiresAt: now + TTL_MS });
  return token;
}

/**
 * Consume a token, returning the service it was minted for.
 *
 * Single-use: redeemed or not, the token is gone afterwards. A replayable token would let anyone
 * who saw it once — in a screenshot, a shoulder-surf, a shared screen — overwrite the account
 * later.
 */
export function redeemPairing(token: string, now: number = Date.now()): Pairing | null {
  sweep(now);
  const found = pending.get(token);
  if (!found) return null;
  pending.delete(token);
  if (found.expiresAt <= now) return null;
  return { serviceId: found.serviceId, config: found.config };
}

/** Whether a token is still usable, without spending it. Drives the page's "waiting" state. */
export function pairingPending(token: string, now: number = Date.now()): boolean {
  sweep(now);
  return pending.has(token);
}
