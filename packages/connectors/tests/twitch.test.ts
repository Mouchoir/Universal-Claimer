import { describe, expect, it } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { TwitchConnector, activeSubSummary } from "../src/twitch/index.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import { supportsInteractiveLogin } from "../src/connector.js";
import type { SubEvidence, TwitchPageDriver } from "../src/twitch/driver.js";
import type { AuthInput, ConnectorContext, JobEvent, SessionHandle } from "../src/connector.js";

const fakeSession = { context: {} } as unknown as SessionHandle;

function makeCtx(over: Partial<ConnectorContext> = {}): { ctx: ConnectorContext; events: JobEvent[] } {
  const events: JobEvent[] = [];
  const ctx: ConnectorContext = {
    browser: { launch: async () => fakeSession, close: async () => {} },
    captcha: new NullCaptchaSolver(),
    totp: () => "000000",
    emit: (e) => events.push(e),
    log: createLogger({ sink: () => {} }),
    ...over,
  };
  return { ctx, events };
}

function fakeDriver(over: Partial<TwitchPageDriver>): TwitchPageDriver {
  return {
    applyCookies: async () => {},
    isAuthenticated: async () => true,
    loginWithPassword: async () => ({ authenticated: true }),
    resubWithPrime: async () => ({ subscribed: true }),
    getUsername: async () => "ExampleUser",
    getPrimeSubEnd: async () => "2026-08-25T00:00:00.000Z",
    // null = "Twitch could not be asked", which is what a fake with no opinion should say.
    isSubscribedTo: async () => null,
    getCookies: async () => [],
    goto: async () => {},
    ...over,
  };
}

const session: AuthInput = { method: "session_import", cookies: [] };
const fp = defaultFingerprint();

describe("TwitchConnector", () => {
  it("declares a required channel config field + interactive login", () => {
    const c = new TwitchConnector();
    expect(supportsInteractiveLogin(c)).toBe(true);
    expect(c.configFields?.[0]).toMatchObject({ key: "channel", required: true });
  });

  it("resubscribes with Prime → claimed", async () => {
    const c = new TwitchConnector({ createDriver: () => fakeDriver({ resubWithPrime: async () => ({ subscribed: true }) }) });
    const res = await c.claim(session, fp, { channel: "ninja" }, makeCtx().ctx);
    expect(res.outcome).toBe("claimed");
    expect(res.summary).toContain("ninja");
  });

  it("already active → nothing_to_claim", async () => {
    const c = new TwitchConnector({ createDriver: () => fakeDriver({ resubWithPrime: async () => ({ subscribed: false, alreadyActive: true }) }) });
    const res = await c.claim(session, fp, { channel: "ninja" }, makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
  });

  it("channel not found → failed", async () => {
    const c = new TwitchConnector({ createDriver: () => fakeDriver({ resubWithPrime: async () => ({ subscribed: false, notFound: true }) }) });
    const res = await c.claim(session, fp, { channel: "nope" }, makeCtx().ctx);
    expect(res.outcome).toBe("failed");
  });

  it("missing channel config → failed", async () => {
    const c = new TwitchConnector();
    const res = await c.claim(session, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("failed");
    expect(res.summary).toMatch(/channel/i);
  });

  it("expired session → reauth_needed", async () => {
    const c = new TwitchConnector({ createDriver: () => fakeDriver({ isAuthenticated: async () => false }) });
    const res = await c.claim(session, fp, { channel: "ninja" }, makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
  });

  it("unsolved captcha → requires_human_action", async () => {
    const c = new TwitchConnector({ createDriver: () => fakeDriver({ resubWithPrime: async () => ({ subscribed: false, captcha: true }) }) });
    const { ctx, events } = makeCtx(); // NullCaptchaSolver → no token
    const res = await c.claim(session, fp, { channel: "ninja" }, ctx);
    expect(res.outcome).toBe("requires_human_action");
    expect(events.some((e) => e.type === "requires_human_action")).toBe(true);
  });

  it("auto-solves captcha then subscribes", async () => {
    let calls = 0;
    const solver: CaptchaSolver = { solve: async () => "TOKEN" };
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({
          resubWithPrime: async () => {
            calls += 1;
            return calls === 1 ? { subscribed: false, captcha: true } : { subscribed: true };
          },
        }),
    });
    const res = await c.claim(session, fp, { channel: "ninja" }, makeCtx({ captcha: solver }).ctx);
    expect(res.outcome).toBe("claimed");
    expect(calls).toBe(2);
  });
});

describe("TwitchConnector: an active sub says how it was decided", () => {
  const PAGE_WHY = 'Twitch returned an error ("failed integrity check")';
  const fromApi = (over: Partial<SubEvidence>): SubEvidence => ({ decidedBy: "api", kind: "unknown", ...over });
  const fromPage: SubEvidence = { decidedBy: "page", kind: "unknown", apiUnavailable: PAGE_WHY };

  it.each<[string, SubEvidence, string]>([
    [
      "Prime, from the API",
      fromApi({ kind: "prime", endsAt: "2026-10-16T21:13:40.000Z" }),
      `Prime sub to "examplechannel" is active until 2026-10-16 (from Twitch's API).`,
    ],
    [
      "paid, from the API",
      fromApi({ kind: "paid", renewsAt: "2026-10-05T12:00:00.000Z" }),
      `Paid sub to "examplechannel" is active, renewing on 2026-10-05 (from Twitch's API).`,
    ],
    [
      "gifted, from the API",
      fromApi({ kind: "gift", endsAt: "2026-11-01T00:00:00.000Z" }),
      `Gifted sub to "examplechannel" is active until 2026-11-01 (from Twitch's API).`,
    ],
    [
      "not Prime, kind unknown, from the API",
      fromApi({ kind: "unknown", endsAt: "2026-11-01T00:00:00.000Z" }),
      `A non-Prime sub to "examplechannel" is active until 2026-11-01 (from Twitch's API).`,
    ],
    [
      "a permanent grant, from the API",
      fromApi({ kind: "unknown" }),
      `A non-Prime sub to "examplechannel" is active with no end date (from Twitch's API).`,
    ],
    [
      "from the page",
      fromPage,
      `A sub to "examplechannel" is active (from the channel page; Twitch's API could not be asked: ${PAGE_WHY}).`,
    ],
  ])("words %s", (_what, evidence, summary) => {
    expect(activeSubSummary("examplechannel", evidence)).toBe(summary);
  });

  it("no longer calls a sub Prime without evidence that it is", () => {
    expect(activeSubSummary("examplechannel", undefined)).toBe(`A sub to "examplechannel" is already active.`);
  });

  it("keeps the outcome and takes the entitlement date from the API's verdict", async () => {
    let asked = 0;
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({
          resubWithPrime: async () => ({
            subscribed: false,
            alreadyActive: true,
            evidence: fromApi({ kind: "prime", endsAt: "2026-10-16T21:13:40.000Z" }),
          }),
          getPrimeSubEnd: async () => {
            asked += 1;
            return "2020-01-01T00:00:00.000Z";
          },
        }),
    });
    const res = await c.claim(session, fp, { channel: "examplechannel" }, makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
    expect(res.summary).toBe(`Prime sub to "examplechannel" is active until 2026-10-16 (from Twitch's API).`);
    expect(res.accountFacts?.entitlements).toEqual([
      { kind: "prime_sub", channel: "examplechannel", endsAt: "2026-10-16T21:13:40.000Z" },
    ]);
    // The API already answered with the dates; asking it again would only risk a different answer.
    expect(asked).toBe(0);
  });

  it("falls back to the renewal date when the sub has no end date", async () => {
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({
          resubWithPrime: async () => ({
            subscribed: false,
            alreadyActive: true,
            evidence: fromApi({ kind: "paid", renewsAt: "2026-10-05T12:00:00.000Z" }),
          }),
        }),
    });
    const res = await c.claim(session, fp, { channel: "examplechannel" }, makeCtx().ctx);
    expect(res.accountFacts?.entitlements?.[0]?.endsAt).toBe("2026-10-05T12:00:00.000Z");
  });

  it("words a page verdict with the API's failure and still reads the end date", async () => {
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({ resubWithPrime: async () => ({ subscribed: false, alreadyActive: true, evidence: fromPage }) }),
    });
    const res = await c.claim(session, fp, { channel: "examplechannel" }, makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
    expect(res.summary).toContain(`(from the channel page; Twitch's API could not be asked: ${PAGE_WHY})`);
    expect(res.accountFacts?.entitlements?.[0]?.endsAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("reads the new end date after a resub rather than the verdict that preceded it", async () => {
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({
          resubWithPrime: async () => ({
            subscribed: true,
            evidence: fromApi({ kind: "prime", endsAt: "2026-08-16T21:13:40.000Z", listHasChannel: true }),
          }),
        }),
    });
    const res = await c.claim(session, fp, { channel: "examplechannel" }, makeCtx().ctx);
    expect(res.outcome).toBe("claimed");
    expect(res.accountFacts?.entitlements?.[0]?.endsAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("logs one verdict line per run, with neutral keys the logger leaves readable", async () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    let calls = 0;
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({
          // A captcha first, so the run calls the driver twice: still one line, for the attempt
          // that counts.
          resubWithPrime: async () => {
            calls += 1;
            if (calls === 1) return { subscribed: false, captcha: true };
            return {
              subscribed: false,
              reason: "no subscribe control matched",
              evidence: {
                decidedBy: "page",
                kind: "unknown",
                apiUnavailable: 'HTTP 401 ("token is invalid")',
                apiHttpStatus: 401,
                apiFirstError: "token is invalid",
                subscribeishTargets: ["subscription-gift-button"],
              },
            };
          },
        }),
    });
    const solver: CaptchaSolver = { solve: async () => "TOKEN" };
    await c.claim(session, fp, { channel: "examplechannel" }, makeCtx({ log, captcha: solver }).ctx);

    const verdicts = lines.map((l) => JSON.parse(l)).filter((r) => r.msg === "twitch sub verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].meta).toEqual({
      decidedBy: "page",
      apiHttpStatus: 401,
      apiErrors: "token is invalid",
      apiUnavailable: 'HTTP 401 ("token is invalid")',
      subscribeishTargets: ["subscription-gift-button"],
      kind: "unknown",
    });
    expect(JSON.stringify(verdicts[0])).not.toContain("[REDACTED]");
  });

  it("logs the API's list facts and dates when the API decided", async () => {
    const lines: string[] = [];
    const c = new TwitchConnector({
      createDriver: () =>
        fakeDriver({
          resubWithPrime: async () => ({
            subscribed: false,
            alreadyActive: true,
            evidence: fromApi({
              kind: "paid",
              renewsAt: "2026-10-05T12:00:00.000Z",
              apiHttpStatus: 200,
              listCount: 3,
              listHasChannel: true,
            }),
          }),
        }),
    });
    const log = createLogger({ sink: (l) => lines.push(l) });
    await c.claim(session, fp, { channel: "examplechannel" }, makeCtx({ log }).ctx);
    const verdict = lines.map((l) => JSON.parse(l)).find((r) => r.msg === "twitch sub verdict");
    expect(verdict.meta).toEqual({
      decidedBy: "api",
      apiHttpStatus: 200,
      listCount: 3,
      listHasChannel: true,
      kind: "paid",
      renewsAt: "2026-10-05T12:00:00.000Z",
    });
  });
});
