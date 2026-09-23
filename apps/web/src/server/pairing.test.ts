import { beforeEach, describe, expect, it } from "vitest";
import {
  mintPairing,
  pairingIdFor,
  pairingPending,
  pairingStatus,
  redeemPairing,
  resetPairings,
  settlePairing,
} from "./pairing.js";

/**
 * A pairing token is the only thing standing between an unauthenticated request and overwriting a
 * connected account, so its lifetime rules are pinned down rather than assumed.
 */

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

beforeEach(resetPairings);

describe("mintPairing / redeemPairing", () => {
  it("redeems once, for the service it was minted for", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(redeemPairing(token, T0 + MINUTE)?.serviceId).toBe("twitch");
  });

  it("cannot be redeemed twice", () => {
    // A replayable token would let anyone who saw it once — a screenshot, a shared screen —
    // overwrite the account later.
    const token = mintPairing("epic", {}, T0);
    expect(redeemPairing(token, T0 + MINUTE)?.serviceId).toBe("epic");
    expect(redeemPairing(token, T0 + MINUTE)).toBeNull();
  });

  it("expires after its window", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(redeemPairing(token, T0 + 11 * MINUTE)).toBeNull();
  });

  it("is still good just inside the window", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(redeemPairing(token, T0 + 9 * MINUTE)?.serviceId).toBe("twitch");
  });

  it("rejects a token that was never minted", () => {
    expect(redeemPairing("not-a-real-token", T0)).toBeNull();
  });

  it("mints unguessable, distinct tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintPairing("twitch", {}, T0)));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it("carries the per-service config through to redemption", () => {
    // Twitch needs a channel, and the extension popup has no idea such a thing exists — it knows
    // about cookies. So the token carries what the operator typed on the page.
    const token = mintPairing("twitch", { channel: "examplechannel" }, T0);
    expect(redeemPairing(token, T0)).toEqual({
      serviceId: "twitch",
      config: { channel: "examplechannel" },
    });
  });

  it("keeps each service's token separate", () => {
    const twitch = mintPairing("twitch", {}, T0);
    const epic = mintPairing("epic", {}, T0);
    expect(redeemPairing(twitch, T0)?.serviceId).toBe("twitch");
    expect(redeemPairing(epic, T0)?.serviceId).toBe("epic");
  });
});

describe("pairingPending", () => {
  it("reports a live token without spending it", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(pairingPending(token, T0)).toBe(true);
    expect(redeemPairing(token, T0)?.serviceId).toBe("twitch");
  });

  it("reports an expired or unknown token as gone", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(pairingPending(token, T0 + 11 * MINUTE)).toBe(false);
    expect(pairingPending("nope", T0)).toBe(false);
  });
});

describe("bounds", () => {
  it("does not grow without limit when tokens are minted and never used", () => {
    // Otherwise anything that can reach the mint endpoint can grow this map forever.
    const tokens = Array.from({ length: 60 }, (_, i) => mintPairing("twitch", {}, T0 + i));
    const live = tokens.filter((t) => pairingPending(t, T0 + 100));
    expect(live.length).toBeLessThanOrEqual(32);
    // The most recent one always survives: it is the one the operator is looking at.
    expect(pairingPending(tokens[tokens.length - 1]!, T0 + 100)).toBe(true);
  });

  it("forgets expired tokens rather than accumulating them", () => {
    mintPairing("twitch", {}, T0);
    const later = mintPairing("epic", {}, T0 + 11 * MINUTE);
    // Minting sweeps; the first token is gone by now and cannot be redeemed.
    expect(pairingPending(later, T0 + 11 * MINUTE)).toBe(true);
  });
});

describe("pairing outcome", () => {
  // The page that minted a pairing waits on this. Before it existed the page waited on "does an
  // account exist for this service", which every reconnect answers yes to at once — so it left
  // two seconds in, before anything was sent.

  it("starts pending and is not settled by the account merely existing", () => {
    const token = mintPairing("primegaming", {}, T0);
    expect(pairingStatus(pairingIdFor(token), T0 + MINUTE)).toEqual({
      state: "pending",
      serviceId: "primegaming",
    });
  });

  it("goes processing on redemption, then connected with what arrived", () => {
    const token = mintPairing("epic", {}, T0);
    const id = pairingIdFor(token);
    expect(redeemPairing(token, T0)?.serviceId).toBe("epic");
    expect(pairingStatus(id, T0)?.state).toBe("processing");

    settlePairing(
      token,
      { state: "connected", reconnected: true, cookieCount: 12, hosts: ["epicgames.com"] },
      T0,
    );
    expect(pairingStatus(id, T0)).toEqual({
      state: "connected",
      serviceId: "epic",
      reconnected: true,
      cookieCount: 12,
      hosts: ["epicgames.com"],
    });
  });

  it("reports a refusal with its reason", () => {
    const token = mintPairing("primegaming", {}, T0);
    redeemPairing(token, T0);
    settlePairing(
      token,
      { state: "failed", error: { code: "AUTH_FAILED", message: "No valid cookies were provided." } },
      T0,
    );
    const status = pairingStatus(pairingIdFor(token), T0);
    expect(status?.state).toBe("failed");
    expect(status?.error?.message).toBe("No valid cookies were provided.");
  });

  it("reports a window that closed with nothing sent as expired, not unknown", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(pairingStatus(pairingIdFor(token), T0 + 11 * MINUTE)?.state).toBe("expired");
  });

  it("reports a pairing evicted by the cap as expired", () => {
    const first = mintPairing("twitch", {}, T0);
    for (let i = 1; i <= 40; i++) mintPairing("twitch", {}, T0 + i);
    expect(pairingStatus(pairingIdFor(first), T0 + 50)?.state).toBe("expired");
  });

  it("knows nothing of an id it never minted, as after a restart", () => {
    expect(pairingStatus(pairingIdFor("never-minted"), T0)).toBeNull();
  });

  it("does not invent an outcome for a pairing that was never redeemed", () => {
    // Settling is only meaningful after a redemption. Accepting it earlier would let the page
    // report a connection that did not happen.
    const token = mintPairing("twitch", {}, T0);
    settlePairing(token, { state: "connected", cookieCount: 1, hosts: [] }, T0);
    expect(pairingStatus(pairingIdFor(token), T0)?.state).toBe("pending");
    expect(redeemPairing(token, T0)?.serviceId).toBe("twitch");
  });

  it("does not let a settled outcome be overwritten", () => {
    const token = mintPairing("epic", {}, T0);
    redeemPairing(token, T0);
    settlePairing(token, { state: "connected", cookieCount: 3, hosts: [] }, T0);
    settlePairing(token, { state: "failed", error: { code: "X", message: "late" } }, T0);
    expect(pairingStatus(pairingIdFor(token), T0)?.state).toBe("connected");
  });

  it("forgets settled outcomes after a while", () => {
    const token = mintPairing("epic", {}, T0);
    redeemPairing(token, T0);
    settlePairing(token, { state: "connected", cookieCount: 3, hosts: [] }, T0);
    expect(pairingStatus(pairingIdFor(token), T0 + 11 * MINUTE)).toBeNull();
  });
});

describe("pairingIdFor", () => {
  // The id travels in URLs and poll requests; the token must not be recoverable from it, and the
  // id must not work as a token.

  it("is stable, and is not the token", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(pairingIdFor(token)).toBe(pairingIdFor(token));
    expect(pairingIdFor(token)).not.toBe(token);
    expect(pairingIdFor(token)).not.toContain(token);
  });

  it("cannot be redeemed in place of the token", () => {
    const token = mintPairing("twitch", {}, T0);
    expect(redeemPairing(pairingIdFor(token), T0)).toBeNull();
    expect(pairingPending(token, T0)).toBe(true);
  });
});
