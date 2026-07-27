import { describe, expect, it } from "vitest";
import { parseSubscriptionBenefits } from "../src/twitch/driver.js";

/** Shaped like a real SubscriptionsManager_User response (batched array, as Twitch returns it). */
function response(nodes: unknown[]) {
  return JSON.stringify([
    { data: { currentUser: { login: "thyiades", subscriptionBenefits: { edges: nodes.map((node) => ({ node })) } } } },
  ]);
}

describe("parseSubscriptionBenefits", () => {
  it("extracts channel, end date and Prime flag", () => {
    const raw = response([
      {
        endsAt: "2026-08-16T21:13:40Z",
        renewsAt: null,
        purchasedWithPrime: true,
        product: { owner: { login: "emptyprofile" } },
      },
    ]);
    expect(parseSubscriptionBenefits(raw)).toEqual([
      { channel: "emptyprofile", endsAt: "2026-08-16T21:13:40.000Z", purchasedWithPrime: true },
    ]);
  });

  it("lowercases the channel so matching is case-insensitive", () => {
    const raw = response([
      { endsAt: "2026-08-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "EmptyProfile" } } },
    ]);
    expect(parseSubscriptionBenefits(raw)[0]!.channel).toBe("emptyprofile");
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
