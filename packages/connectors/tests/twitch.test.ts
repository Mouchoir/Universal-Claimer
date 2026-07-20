import { describe, expect, it } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { TwitchConnector } from "../src/twitch/index.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import { supportsInteractiveLogin } from "../src/connector.js";
import type { TwitchPageDriver } from "../src/twitch/driver.js";
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
