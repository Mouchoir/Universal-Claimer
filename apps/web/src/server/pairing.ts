import { createHash, randomBytes } from "node:crypto";

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
 *
 * Each pairing also has an outcome, which the page that minted it polls. Without one the page had
 * nothing to wait on but "does an account exist for this service", which is already true for
 * every reconnect — so it declared success two seconds in, left, and took the pairing URL with it.
 * The outcome is keyed by an id derived from the token rather than by the token itself: the id is
 * safe to put in a URL or a log, and knowing it does not let anyone redeem anything.
 */

/** Long enough that guessing is hopeless; the window is minutes and single-use besides. */
const TOKEN_BYTES = 32;
const TTL_MS = 10 * 60 * 1000;
/** A ceiling so a script hammering the mint endpoint cannot grow this without bound. */
const MAX_PENDING = 32;
/** How long a settled outcome stays readable. The page reads it within seconds. */
const OUTCOME_TTL_MS = 10 * 60 * 1000;
const MAX_OUTCOMES = 64;

export interface Pairing {
  serviceId: string;
  /**
   * Per-service settings the operator filled in on the page — Twitch's channel, for instance.
   * Carried by the token because the extension has no way to ask for them: its popup knows about
   * cookies, not about what a given connector needs.
   */
  config: Record<string, string>;
}

/**
 * Where a pairing stands, as the page that minted it sees it.
 *
 * `pending` until the extension sends something, `processing` while the instance stores it, then
 * `connected` or `failed`. `expired` when the window closed with nothing sent.
 */
export type PairingState = "pending" | "processing" | "connected" | "failed" | "expired";

export interface PairingStatus {
  state: PairingState;
  serviceId: string;
  /** Set when connected: whether an existing account's session was replaced. */
  reconnected?: boolean;
  /** Set when connected: how many cookies arrived, and for which hosts. Never their values. */
  cookieCount?: number;
  hosts?: string[];
  /** Set when failed: what went wrong, in words the operator can act on. */
  error?: { code: string; message: string };
}

interface Entry extends Pairing {
  id: string;
  expiresAt: number;
}

interface Outcome {
  status: PairingStatus;
  keepUntil: number;
}

const pending = new Map<string, Entry>();
const outcomes = new Map<string, Outcome>();

/** Test seam. */
export function resetPairings(): void {
  pending.clear();
  outcomes.clear();
}

/**
 * The public id of a pairing. One-way, so the page can hold and poll it without holding anything
 * that redeems.
 */
export function pairingIdFor(token: string): string {
  return createHash("sha256").update(`uc-pairing:${token}`).digest("base64url");
}

function record(id: string, status: PairingStatus, now: number): void {
  outcomes.delete(id);
  // Oldest-first, for the same reason as the pending cap below.
  while (outcomes.size >= MAX_OUTCOMES) {
    const oldest = outcomes.keys().next().value;
    if (oldest === undefined) break;
    outcomes.delete(oldest);
  }
  outcomes.set(id, { status, keepUntil: now + OUTCOME_TTL_MS });
}

function sweep(now: number): void {
  for (const [token, p] of pending) {
    if (p.expiresAt <= now) {
      pending.delete(token);
      // Remembered as expired rather than forgotten, so the page can say the window closed
      // instead of claiming not to know the pairing at all.
      record(p.id, { state: "expired", serviceId: p.serviceId }, now);
    }
  }
  for (const [id, o] of outcomes) if (o.keepUntil <= now) outcomes.delete(id);
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
    record(oldest[1].id, { state: "expired", serviceId: oldest[1].serviceId }, now);
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  pending.set(token, { id: pairingIdFor(token), serviceId, config, expiresAt: now + TTL_MS });
  return token;
}

/**
 * Consume a token, returning the service it was minted for.
 *
 * Single-use: redeemed or not, the token is gone afterwards. A replayable token would let anyone
 * who saw it once — in a screenshot, a shoulder-surf, a shared screen — overwrite the account
 * later.
 *
 * A successful redemption moves the pairing to `processing`; the caller is expected to settle it
 * with {@link settlePairing} on every path out, success or failure.
 */
export function redeemPairing(token: string, now: number = Date.now()): Pairing | null {
  sweep(now);
  const found = pending.get(token);
  if (!found) return null;
  pending.delete(token);
  if (found.expiresAt <= now) {
    record(found.id, { state: "expired", serviceId: found.serviceId }, now);
    return null;
  }
  record(found.id, { state: "processing", serviceId: found.serviceId }, now);
  return { serviceId: found.serviceId, config: found.config };
}

/** Record how a redeemed pairing ended. */
export function settlePairing(
  token: string,
  status: Omit<PairingStatus, "serviceId" | "state"> & { state: "connected" | "failed" },
  now: number = Date.now(),
): void {
  const id = pairingIdFor(token);
  const current = outcomes.get(id);
  // Only a pairing that was actually redeemed can be settled. Anything else is a caller bug, and
  // inventing an outcome for it would make the page report something that did not happen.
  if (!current || current.status.state !== "processing") return;
  record(id, { ...status, serviceId: current.status.serviceId }, now);
}

/** Whether a token is still usable, without spending it. */
export function pairingPending(token: string, now: number = Date.now()): boolean {
  sweep(now);
  return pending.has(token);
}

/**
 * Where a pairing stands, by its public id. Null when this instance has no record of it — most
 * often because it restarted since the pairing was minted.
 */
export function pairingStatus(id: string, now: number = Date.now()): PairingStatus | null {
  sweep(now);
  for (const p of pending.values()) {
    if (p.id === id) return { state: "pending", serviceId: p.serviceId };
  }
  return outcomes.get(id)?.status ?? null;
}
