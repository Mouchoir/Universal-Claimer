import { describe, expect, it } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { MsRewardsConnector } from "../src/msrewards/index.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import { supportsInteractiveLogin } from "../src/connector.js";
import type { MsRewardsPageDriver } from "../src/msrewards/driver.js";
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

function fakeDriver(over: Partial<MsRewardsPageDriver>): MsRewardsPageDriver {
  return {
    applyCookies: async () => {},
    isAuthenticated: async () => true,
    loginWithPassword: async () => ({ authenticated: true }),
    remainingSearches: async () => 0,
    search: async () => ({ ok: true }),
    getCookies: async () => [],
    goto: async () => {},
    ...over,
  };
}

// Deterministic, fast deps: no real delays, fixed RNG.
const fastDeps = (driver: MsRewardsPageDriver) => ({
  createDriver: () => driver,
  sleep: async () => {},
  rand: () => 0.42,
});

const session: AuthInput = { method: "session_import", cookies: [] };
const fp = defaultFingerprint();

describe("MsRewardsConnector", () => {
  it("has no per-account config and supports assisted login", () => {
    const c = new MsRewardsConnector();
    expect(c.configFields).toEqual([]);
    expect(supportsInteractiveLogin(c)).toBe(true);
  });

  it("nothing outstanding → nothing_to_claim", async () => {
    const c = new MsRewardsConnector(fastDeps(fakeDriver({ remainingSearches: async () => 0 })));
    const res = await c.claim(session, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
  });

  it("performs the outstanding searches → claimed with a count", async () => {
    let searches = 0;
    const c = new MsRewardsConnector(
      fastDeps(
        fakeDriver({
          remainingSearches: async () => 3,
          search: async () => {
            searches += 1;
            return { ok: true };
          },
        }),
      ),
    );
    const res = await c.claim(session, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("claimed");
    expect(searches).toBe(3);
    expect(res.summary).toContain("3");
  });

  it("caps searches at maxSearches", async () => {
    let searches = 0;
    const c = new MsRewardsConnector({
      createDriver: () =>
        fakeDriver({ remainingSearches: async () => 100, search: async () => { searches += 1; return { ok: true }; } }),
      sleep: async () => {},
      rand: () => 0.1,
      maxSearches: 5,
    });
    await c.claim(session, fp, {}, makeCtx().ctx);
    expect(searches).toBe(5);
  });

  it("expired session → reauth_needed", async () => {
    const c = new MsRewardsConnector(fastDeps(fakeDriver({ isAuthenticated: async () => false })));
    const res = await c.claim(session, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
  });

  it("unsolved verification before any search → requires_human_action", async () => {
    const c = new MsRewardsConnector(
      fastDeps(fakeDriver({ remainingSearches: async () => 3, search: async () => ({ ok: false, captcha: true }) })),
    );
    const { ctx, events } = makeCtx(); // NullCaptchaSolver
    const res = await c.claim(session, fp, {}, ctx);
    expect(res.outcome).toBe("requires_human_action");
    expect(events.some((e) => e.type === "requires_human_action")).toBe(true);
  });

  it("auto-solves verification and continues", async () => {
    const solver: CaptchaSolver = { solve: async () => "TOKEN" };
    let n = 0;
    const c = new MsRewardsConnector(
      fastDeps(
        fakeDriver({
          remainingSearches: async () => 2,
          search: async () => {
            n += 1;
            return n === 1 ? { ok: false, captcha: true } : { ok: true };
          },
        }),
      ),
    );
    const res = await c.claim(session, fp, {}, makeCtx({ captcha: solver }).ctx);
    // First search hit a captcha (auto-solved), loop continued; at least one search completed.
    expect(res.outcome).toBe("claimed");
  });
});
