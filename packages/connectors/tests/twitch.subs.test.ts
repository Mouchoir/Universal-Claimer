import { describe, expect, it } from "vitest";
import {
  futureDate,
  hasActiveSub,
  parseSubscriptionBenefits,
  readSubscriptionReply,
  subKind,
  verdictFromApi,
  type SubscriptionLookup,
} from "../src/twitch/driver.js";

/** Shaped like a real SubscriptionsManager_User response (batched array, as Twitch returns it). */
function response(nodes: unknown[]) {
  return JSON.stringify([
    { data: { currentUser: { login: "example_user", subscriptionBenefits: { edges: nodes.map((node) => ({ node })) } } } },
  ]);
}

/**
 * Replies that are not an answer. Each must read as "could not ask" (null), never as "subscribed
 * to nothing" ([]), because only the second one starts a resubscribe.
 */
const UNANSWERED: Record<string, string> = {
  "an errors array with no data": JSON.stringify([{ errors: [{ message: "failed integrity check" }] }]),
  "an unbatched errors array": JSON.stringify({ errors: [{ message: "unauthorized" }] }),
  "errors with data: null": JSON.stringify([{ errors: [{ message: "service error" }], data: null }]),
  "a body that is not JSON": "<html>Bad gateway</html>",
  "currentUser: null": JSON.stringify([{ data: { currentUser: null } }]),
  "no currentUser at all": JSON.stringify([{ data: {} }]),
  "subscriptionBenefits: null": JSON.stringify([{ data: { currentUser: { login: "example_user", subscriptionBenefits: null } } }]),
  "an empty batch": "[]",
};

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
    expect(parseSubscriptionBenefits(raw)![0]!.channel).toBe("mixedcasechannel");
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
    expect(parseSubscriptionBenefits(raw)!.map((s) => s.channel)).toEqual(["a", "b"]);
  });

  it("skips entries without an owner login", () => {
    const raw = response([{ endsAt: "2026-08-16T21:13:40Z", purchasedWithPrime: true, product: null }]);
    expect(parseSubscriptionBenefits(raw)).toEqual([]);
  });

  it("reads a reply that carries an empty list as subscribed to nothing", () => {
    // The one case that is a real "[]": Twitch answered, for a signed-in account, with no subs.
    expect(parseSubscriptionBenefits(response([]))).toEqual([]);
  });

  for (const [what, raw] of Object.entries(UNANSWERED)) {
    it(`reads ${what} as unknown (null), never as an empty list`, () => {
      expect(parseSubscriptionBenefits(raw)).toBeNull();
    });
  }

  it("keeps the renewal date the query already asks for", () => {
    const raw = response([
      {
        endsAt: null,
        renewsAt: "2026-10-05T12:00:00Z",
        purchasedWithPrime: false,
        product: { owner: { login: "examplechannel" } },
      },
    ]);
    expect(parseSubscriptionBenefits(raw)).toEqual([
      { channel: "examplechannel", renewsAt: "2026-10-05T12:00:00.000Z", purchasedWithPrime: false },
    ]);
  });

  it("does not throw on a bad date, and does not let it pass for a permanent grant", () => {
    // new Date("soon").toISOString() throws a RangeError, which used to take the whole reply down.
    // Dropping the date instead would be worse: no end date reads as "permanent", i.e. active.
    const raw = response([
      { endsAt: "soon", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
      { endsAt: 1760000000, purchasedWithPrime: true, product: { owner: { login: "otherchannel" } } },
    ]);
    expect(() => parseSubscriptionBenefits(raw)).not.toThrow();
    expect(parseSubscriptionBenefits(raw)).toEqual([
      { channel: "examplechannel", purchasedWithPrime: true, unreadableDate: true },
      { channel: "otherchannel", purchasedWithPrime: true, unreadableDate: true },
    ]);
  });

  it("drops a renewal date that does not parse without making the benefit unreadable", () => {
    // Only the end date says whether a benefit runs; a bad renewal date can only cost the wording.
    const raw = response([
      { endsAt: "2026-10-16T21:13:40Z", renewsAt: "soon", purchasedWithPrime: false, product: { owner: { login: "examplechannel" } } },
    ]);
    expect(parseSubscriptionBenefits(raw)).toEqual([
      { channel: "examplechannel", endsAt: "2026-10-16T21:13:40.000Z", purchasedWithPrime: false },
    ]);
  });
});

describe("readSubscriptionReply", () => {
  it("says why for each reply that is not an answer", () => {
    const why = (status: number, body: string) => readSubscriptionReply(status, body).failure;
    expect(why(200, UNANSWERED["an errors array with no data"]!)).toBe(
      'Twitch returned an error ("failed integrity check")',
    );
    expect(why(200, UNANSWERED["a body that is not JSON"]!)).toBe("the reply was not JSON");
    expect(why(200, UNANSWERED["currentUser: null"]!)).toBe("the reply named no signed-in account");
    expect(why(200, UNANSWERED["subscriptionBenefits: null"]!)).toBe(
      "the reply carried no subscription list",
    );
    expect(why(200, "[]")).toBe("the reply carried no data");
  });

  it("reads a non-2xx reply as unknown, with its status and first error", () => {
    const lookup = readSubscriptionReply(
      401,
      JSON.stringify({ errors: [{ message: "token is invalid" }, { message: "second" }] }),
    );
    expect(lookup).toEqual({
      subs: null,
      httpStatus: 401,
      firstError: "token is invalid",
      failure: 'HTTP 401 ("token is invalid")',
    });
    expect(readSubscriptionReply(503, "Service Unavailable")).toEqual({
      subs: null,
      httpStatus: 503,
      failure: "HTTP 503",
    });
  });

  it("keeps a readable list that comes with a partial error, and records the error", () => {
    const body = JSON.stringify([
      {
        errors: [{ message: "product unavailable" }],
        data: {
          currentUser: {
            subscriptionBenefits: {
              edges: [{ node: { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } } }],
            },
          },
        },
      },
    ]);
    const lookup = readSubscriptionReply(200, body);
    expect(lookup.subs).toEqual([
      { channel: "examplechannel", endsAt: "2026-10-16T21:13:40.000Z", purchasedWithPrime: true },
    ]);
    expect(lookup.firstError).toBe("product unavailable");
    expect(lookup.failure).toBeUndefined();
  });

  it("counts the list's entries, and the ones it had to skip", () => {
    const body = JSON.stringify([
      {
        errors: [{ message: "product unavailable" }],
        data: {
          currentUser: {
            subscriptionBenefits: {
              edges: [
                { node: { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "otherchannel" } } } },
                { node: { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: null } },
                { node: null },
                null,
              ],
            },
          },
        },
      },
    ]);
    const lookup = readSubscriptionReply(200, body);
    expect(lookup.subs).toHaveLength(1);
    expect(lookup).toMatchObject({ edgeCount: 4, skippedEdges: 3, firstError: "product unavailable" });
  });

  it("keeps an error message to one bounded line", () => {
    const long = `first line\n   second line ${"x".repeat(400)}`;
    const lookup = readSubscriptionReply(200, JSON.stringify({ errors: [{ message: long }] }));
    expect(lookup.firstError).not.toMatch(/\n/);
    expect(lookup.firstError!.length).toBeLessThanOrEqual(160);
    expect(lookup.firstError).toMatch(/^first line second line x+\.\.\.$/);
  });
});

describe("subKind", () => {
  it("tells Prime, paid and unknown apart from the flags the reply carries", () => {
    expect(subKind({ channel: "a", endsAt: "2026-10-16T00:00:00.000Z", purchasedWithPrime: true })).toBe("prime");
    // Only a sub someone pays for on a schedule renews on its own.
    expect(subKind({ channel: "a", renewsAt: "2026-10-16T00:00:00.000Z", purchasedWithPrime: false })).toBe("paid");
    // Not Prime and not renewing: a gift, a cancelled sub or a promotion. The reply cannot say which.
    expect(subKind({ channel: "a", endsAt: "2026-10-16T00:00:00.000Z", purchasedWithPrime: false })).toBe("unknown");
    expect(subKind(undefined)).toBe("unknown");
  });
});

describe("verdictFromApi", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");
  const lookup = (body: string, status = 200): SubscriptionLookup => readSubscriptionReply(status, body);

  for (const [what, raw] of Object.entries(UNANSWERED)) {
    it(`leaves ${what} to the page instead of calling it "not subscribed"`, () => {
      const v = verdictFromApi(lookup(raw), "examplechannel", NOW);
      expect(v.known).toBe(false);
      expect(v.evidence).toMatchObject({ decidedBy: "page", kind: "unknown" });
      expect(v.evidence.apiUnavailable).toBeTruthy();
    });
  }

  it("leaves a failed HTTP call and a failed request to the page too", () => {
    expect(verdictFromApi(lookup("", 500), "examplechannel", NOW)).toEqual({
      known: false,
      evidence: { decidedBy: "page", kind: "unknown", apiUnavailable: "HTTP 500", apiHttpStatus: 500 },
    });
    const failed = { subs: null, failure: "the request failed (Failed to fetch)" };
    expect(verdictFromApi(failed, "examplechannel", NOW).evidence.apiUnavailable).toBe(
      "the request failed (Failed to fetch)",
    );
  });

  it("answers 'not subscribed' only for a list that was actually read", () => {
    expect(verdictFromApi(lookup(response([])), "examplechannel", NOW)).toEqual({
      known: true,
      active: false,
      evidence: {
        decidedBy: "api",
        kind: "unknown",
        apiHttpStatus: 200,
        listCount: 0,
        edgeCount: 0,
        listHasChannel: false,
      },
    });
  });

  it("reports a live Prime sub with its end date", () => {
    const raw = response([
      { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "ExampleChannel" } } },
      { endsAt: "2027-01-01T00:00:00Z", purchasedWithPrime: false, product: { owner: { login: "otherchannel" } } },
    ]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toEqual({
      known: true,
      active: true,
      evidence: {
        decidedBy: "api",
        kind: "prime",
        endsAt: "2026-10-16T21:13:40.000Z",
        apiHttpStatus: 200,
        listCount: 2,
        edgeCount: 2,
        listHasChannel: true,
      },
    });
  });

  it("reports a renewing paid sub with its renewal date", () => {
    const raw = response([
      { endsAt: null, renewsAt: "2026-10-05T12:00:00Z", purchasedWithPrime: false, product: { owner: { login: "examplechannel" } } },
    ]);
    const v = verdictFromApi(lookup(raw), "examplechannel", NOW);
    expect(v).toMatchObject({ known: true, active: true });
    expect(v.evidence).toMatchObject({ decidedBy: "api", kind: "paid", renewsAt: "2026-10-05T12:00:00.000Z" });
    expect(v.evidence.endsAt).toBeUndefined();
  });

  it("reports a live sub that is neither Prime nor renewing as active, of unknown kind", () => {
    // A gift, a cancelled sub or a promotion: the reply cannot say which, but it does say it runs.
    const raw = response([
      { endsAt: "2026-11-01T00:00:00Z", renewsAt: null, purchasedWithPrime: false, product: { owner: { login: "examplechannel" } } },
    ]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toEqual({
      known: true,
      active: true,
      evidence: {
        decidedBy: "api",
        kind: "unknown",
        endsAt: "2026-11-01T00:00:00.000Z",
        apiHttpStatus: 200,
        listCount: 1,
        edgeCount: 1,
        listHasChannel: true,
      },
    });
  });

  it("describes a lapsed sub by its latest end date, so the log shows why a renewal is due", () => {
    const raw = response([
      { endsAt: "2026-06-16T00:00:00Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
      { endsAt: "2026-08-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
    ]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toMatchObject({
      known: true,
      active: false,
      evidence: { decidedBy: "api", kind: "prime", endsAt: "2026-08-16T21:13:40.000Z", listHasChannel: true },
    });
  });

  it("leaves a channel whose only benefit has a bad date to the page", () => {
    const raw = response([{ endsAt: "soon", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } }]);
    const v = verdictFromApi(lookup(raw), "examplechannel", NOW);
    expect(v.known).toBe(false);
    expect(v.evidence.apiUnavailable).toBe("the reply's date for this channel does not parse");
  });

  it("still trusts a live benefit when another one for the channel has a bad date", () => {
    const raw = response([
      { endsAt: "soon", purchasedWithPrime: false, product: { owner: { login: "examplechannel" } } },
      { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
    ]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toMatchObject({
      known: true,
      active: true,
      evidence: { kind: "prime", endsAt: "2026-10-16T21:13:40.000Z" },
    });
  });

  it("still trusts a readable future end date when the renewal date does not parse", () => {
    const raw = response([
      { endsAt: "2026-10-16T21:13:40Z", renewsAt: "soon", purchasedWithPrime: false, product: { owner: { login: "examplechannel" } } },
    ]);
    const v = verdictFromApi(lookup(raw), "examplechannel", NOW);
    expect(v).toMatchObject({ known: true, active: true, evidence: { decidedBy: "api", endsAt: "2026-10-16T21:13:40.000Z" } });
    expect(v.evidence.renewsAt).toBeUndefined();
  });

  it("ignores a bad date on another channel", () => {
    const raw = response([{ endsAt: "soon", purchasedWithPrime: true, product: { owner: { login: "otherchannel" } } }]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toMatchObject({ known: true, active: false });
  });

  /** A partial result: an error, and a list in which Twitch nulled some entries' product. */
  const partial = (nodes: unknown[]) =>
    JSON.stringify([
      {
        errors: [{ message: "product unavailable" }],
        data: { currentUser: { subscriptionBenefits: { edges: nodes.map((node) => ({ node })) } } },
      },
    ]);

  it("leaves a list that an error left with holes to the page, when nothing live came through", () => {
    // The entry whose product came back null may be this channel's live benefit.
    const raw = partial([
      { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: null },
      { endsAt: "2026-06-16T00:00:00Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
    ]);
    const v = verdictFromApi(lookup(raw), "examplechannel", NOW);
    expect(v.known).toBe(false);
    expect(v.evidence).toMatchObject({
      decidedBy: "page",
      kind: "unknown",
      apiUnavailable: `the reply's list is incomplete ("product unavailable")`,
      apiFirstError: "product unavailable",
      listCount: 1,
      edgeCount: 2,
    });
  });

  it("still trusts a live benefit that came through a list with holes", () => {
    const raw = partial([
      { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: null },
      { endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
    ]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toMatchObject({ known: true, active: true });
  });

  it("reads an entry Twitch nulled without any error as its answer, not as a hole", () => {
    const raw = response([{ endsAt: "2026-10-16T21:13:40Z", purchasedWithPrime: true, product: null }]);
    expect(verdictFromApi(lookup(raw), "examplechannel", NOW)).toMatchObject({
      known: true,
      active: false,
      evidence: { decidedBy: "api", listCount: 0, edgeCount: 1 },
    });
  });
});

describe("futureDate", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("keeps only a date that is still ahead", () => {
    expect(futureDate("2026-10-05T12:00:00.000Z", NOW)).toBe("2026-10-05T12:00:00.000Z");
    expect(futureDate("2026-09-05T12:00:00.000Z", NOW)).toBeUndefined();
    expect(futureDate("2026-09-20T12:00:00.000Z", NOW)).toBeUndefined();
    expect(futureDate(undefined, NOW)).toBeUndefined();
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

  it("does not count a benefit whose date the parser could not read as a permanent grant", () => {
    const unreadable = { channel: "examplechannel", purchasedWithPrime: true, unreadableDate: true as const };
    expect(hasActiveSub([unreadable], "examplechannel", NOW)).toBe(false);
  });
});
