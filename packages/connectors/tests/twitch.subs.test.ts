import { describe, expect, it } from "vitest";
import { hasActiveSub, parseSubscriptionBenefits } from "../src/twitch/driver.js";

/** Shaped like a real SubscriptionsManager_User response (batched array, as Twitch returns it). */
function response(nodes: unknown[]) {
  return JSON.stringify([
    { data: { currentUser: { login: "example_user", subscriptionBenefits: { edges: nodes.map((node) => ({ node })) } } } },
  ]);
}

describe("parseSubscriptionBenefits", () => {
  it("extracts channel, end date and Prime flag", () => {
    const raw = response([
      {
        endsAt: "2026-08-16T21:13:40Z",
        renewsAt: null,
        purchasedWithPrime: true,
        product: { owner: { login: "examplechannel" } },
      },
    ]);
    expect(parseSubscriptionBenefits(raw)).toEqual([
      { channel: "examplechannel", endsAt: "2026-08-16T21:13:40.000Z", purchasedWithPrime: true },
    ]);
  });

  it("lowercases the channel so matching is case-insensitive", () => {
    const raw = response([
      { endsAt: "2026-08-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "MixedCaseChannel" } } },
    ]);
    expect(parseSubscriptionBenefits(raw)[0]!.channel).toBe("mixedcasechannel");
  });

  it("keeps subs with no end date (permanent grants) without an endsAt", () => {
    const raw = response([
      { endsAt: null, purchasedWithPrime: false, product: { owner: { login: "overwatchleague_2018" } } },
    ]);
    expect(parseSubscriptionBenefits(raw)).toEqual([
      { channel: "overwatchleague_2018", purchasedWithPrime: false },
    ]);
  });

  it("returns every subscription in the response", () => {
    const raw = response([
      { endsAt: "2026-08-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "a" } } },
      { endsAt: "2026-08-04T22:21:51Z", purchasedWithPrime: false, product: { owner: { login: "b" } } },
    ]);
    expect(parseSubscriptionBenefits(raw).map((s) => s.channel)).toEqual(["a", "b"]);
  });

  it("skips entries without an owner login", () => {
    const raw = response([{ endsAt: "2026-08-16T21:13:40Z", purchasedWithPrime: true, product: null }]);
    expect(parseSubscriptionBenefits(raw)).toEqual([]);
  });

  it("tolerates malformed or empty payloads", () => {
    expect(parseSubscriptionBenefits("not json")).toEqual([]);
    expect(parseSubscriptionBenefits("[]")).toEqual([]);
    expect(parseSubscriptionBenefits(JSON.stringify([{ data: {} }]))).toEqual([]);
    expect(parseSubscriptionBenefits(JSON.stringify({ errors: [{ message: "unauthorized" }] }))).toEqual([]);
  });
});

describe("hasActiveSub", () => {
  const NOW = Date.parse("2026-08-31T23:00:00.000Z");
  const sub = (channel: string, endsAt?: string, prime = true) => ({
    channel,
    ...(endsAt ? { endsAt } : {}),
    purchasedWithPrime: prime,
  });

  it("is false for a sub that has already ended", () => {
    // The case reported on 31/08/2026: the account had lapsed and Twitch was offering
    // "Se réabonner", while the connector reported the sub as active and skipped the renewal.
    expect(hasActiveSub([sub("emptyprofile", "2026-08-16T21:13:40.000Z")], "emptyprofile", NOW))
      .toBe(false);
  });

  it("is true while the benefit still runs", () => {
    expect(hasActiveSub([sub("emptyprofile", "2026-09-16T21:13:40.000Z")], "emptyprofile", NOW))
      .toBe(true);
  });

  it("counts a benefit with no end date as permanent", () => {
    expect(hasActiveSub([sub("overwatchleague_2018")], "overwatchleague_2018", NOW)).toBe(true);
  });

  it("ignores other channels, however active", () => {
    expect(hasActiveSub([sub("someoneelse", "2027-01-01T00:00:00.000Z")], "emptyprofile", NOW))
      .toBe(false);
  });

  it("matches the channel case-insensitively and ignores padding", () => {
    expect(hasActiveSub([sub("emptyprofile", "2026-09-16T21:13:40.000Z")], "  EmptyProfile ", NOW))
      .toBe(true);
  });

  it("is false on an empty list", () => {
    expect(hasActiveSub([], "emptyprofile", NOW)).toBe(false);
  });

  it("ignores an unparseable end date rather than treating it as active", () => {
    expect(hasActiveSub([sub("emptyprofile", "not-a-date")], "emptyprofile", NOW)).toBe(false);
  });
});
