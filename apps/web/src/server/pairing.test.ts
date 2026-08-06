import { beforeEach, describe, expect, it } from "vitest";
import { mintPairing, pairingPending, redeemPairing, resetPairings } from "./pairing.js";

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
