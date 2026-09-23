import { describe, expect, it } from "vitest";
import { PlaywrightTwitchDriver } from "../src/twitch/driver.js";
import type { SessionHandle } from "../src/connector.js";

const SUBSCRIBED_MARKER = "[data-a-target='subscribed-button']";
const SUBSCRIBE_BUTTON = "button[data-a-target='subscribe-button']";

/** What the in-page fetch to Twitch's GraphQL endpoint comes back with, or the error it throws. */
type Reply = { status: number; body: string } | Error;

/**
 * Just enough of a Playwright page for `resubWithPrime`: `present` lists the selectors the page
 * matches, and every click is recorded, so a test can say whether a resubscribe was attempted.
 */
function fakeSession(opts: {
  reply: Reply;
  present: string[];
  targets?: string[];
  /** Selectors that appear once something has been clicked, e.g. a captcha. */
  afterClick?: string[];
}) {
  const clicks: string[] = [];
  const present = [...opts.present];
  const locator = (sel: string) => {
    const loc = {
      count: async () => (present.includes(sel) ? 1 : 0),
      click: async () => {
        clicks.push(sel);
        present.push(...(opts.afterClick ?? []));
      },
      first: () => loc,
      last: () => loc,
    };
    return loc;
  };
  const byText = (label: string) => () => {
    const loc = { click: async () => void clicks.push(label), first: () => loc, last: () => loc };
    return loc;
  };
  const page = {
    url: () => "https://www.twitch.tv/examplechannel",
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => {
      if (opts.reply instanceof Error) throw opts.reply;
      return opts.reply;
    },
    locator,
    getByText: byText("text"),
    getByRole: byText("role"),
    $$eval: async () => opts.targets ?? [],
    waitForTimeout: async () => {},
  };
  const context = { pages: () => [page], newPage: async () => page, cookies: async () => [] };
  return { session: { context } as unknown as SessionHandle, clicks };
}

const ok = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) });
const subsReply = (nodes: unknown[]) =>
  ok([{ data: { currentUser: { login: "example_user", subscriptionBenefits: { edges: nodes.map((node) => ({ node })) } } } }]);

/** Replies that leave the API's answer unknown: the bug was reading every one of them as "[]". */
const UNKNOWN: Record<string, Reply> = {
  "an errors array with no data": ok([{ errors: [{ message: "failed integrity check" }] }]),
  "a body that is not JSON": { status: 200, body: "<html>Bad gateway</html>" },
  "currentUser: null": ok([{ data: { currentUser: null } }]),
  "an HTTP error": { status: 500, body: "" },
  "a request that throws": new Error("page.evaluate: TypeError: Failed to fetch"),
};

describe("PlaywrightTwitchDriver.resubWithPrime: how the verdict is reached", () => {
  for (const [what, reply] of Object.entries(UNKNOWN)) {
    it(`never resubscribes on ${what} while the page shows an active sub`, async () => {
      // Before the fix, the first three parsed to "subscribed to nothing", the page was never
      // consulted, and the subscribe button was clicked on an account that was subscribed.
      const { session, clicks } = fakeSession({ reply, present: [SUBSCRIBED_MARKER, SUBSCRIBE_BUTTON] });
      const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
      expect(res).toMatchObject({ subscribed: false, alreadyActive: true });
      expect(res.evidence).toMatchObject({ decidedBy: "page", kind: "unknown" });
      expect(res.evidence?.apiUnavailable).toBeTruthy();
      expect(clicks).toEqual([]);
    });
  }

  it("says why the page had to decide", async () => {
    const { session } = fakeSession({ reply: UNKNOWN["a request that throws"]!, present: [SUBSCRIBED_MARKER] });
    const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
    expect(res.evidence?.apiUnavailable).toBe(
      "the request failed (page.evaluate: TypeError: Failed to fetch)",
    );
  });

  it("lets the page decide a resubscribe when the API is unknown and the page shows none", async () => {
    // Unknown hands the question to the page; it does not answer it. Here the page says "not
    // subscribed", so the resubscribe is the page's verdict, and the evidence says so.
    const { session, clicks } = fakeSession({ reply: UNKNOWN["an HTTP error"]!, present: [SUBSCRIBE_BUTTON] });
    const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
    expect(clicks[0]).toBe(SUBSCRIBE_BUTTON);
    expect(res.evidence).toMatchObject({ decidedBy: "page", apiUnavailable: "HTTP 500", apiHttpStatus: 500 });
  });

  it("trusts the API over the page when Twitch says the sub is live", async () => {
    const reply = subsReply([
      { endsAt: "2099-01-01T00:00:00Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
    ]);
    const { session, clicks } = fakeSession({ reply, present: [SUBSCRIBE_BUTTON] });
    const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
    expect(res).toMatchObject({ subscribed: false, alreadyActive: true });
    expect(res.evidence).toMatchObject({ decidedBy: "api", kind: "prime", endsAt: "2099-01-01T00:00:00.000Z" });
    expect(clicks).toEqual([]);
  });

  it("resubscribes on the API's word when the sub has lapsed, whatever the page shows", async () => {
    const reply = subsReply([
      { endsAt: "2026-01-01T00:00:00Z", purchasedWithPrime: true, product: { owner: { login: "examplechannel" } } },
    ]);
    const { session, clicks } = fakeSession({ reply, present: [SUBSCRIBED_MARKER, SUBSCRIBE_BUTTON] });
    const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
    expect(clicks[0]).toBe(SUBSCRIBE_BUTTON);
    expect(res.evidence).toMatchObject({ decidedBy: "api", listHasChannel: true, endsAt: "2026-01-01T00:00:00.000Z" });
  });

  it("keeps the verdict on a captcha met after the API was asked", async () => {
    const { session } = fakeSession({
      reply: subsReply([]),
      present: [SUBSCRIBE_BUTTON],
      afterClick: ["iframe[src*='hcaptcha'], iframe[src*='recaptcha']"],
    });
    const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
    expect(res).toMatchObject({ subscribed: false, captcha: true });
    expect(res.evidence).toMatchObject({ decidedBy: "api", listCount: 0 });
  });

  it("carries the page's subscribe-like targets when no subscribe control matched", async () => {
    const { session } = fakeSession({
      reply: subsReply([]),
      present: [],
      targets: ["subscription-gift-button", "tier-selector"],
    });
    const res = await new PlaywrightTwitchDriver(session).resubWithPrime("examplechannel");
    expect(res.subscribed).toBe(false);
    expect(res.reason).toMatch(/subscription-gift-button, tier-selector/);
    expect(res.evidence).toMatchObject({
      decidedBy: "api",
      listCount: 0,
      listHasChannel: false,
      subscribeishTargets: ["subscription-gift-button", "tier-selector"],
    });
  });
});
