import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { EpicConnector } from "../src/epic/index.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import type { EpicPageDriver } from "../src/epic/driver.js";
import type { AuthInput, ConnectorContext, JobEvent, SessionHandle } from "../src/connector.js";

const fakeSession = { context: {} } as unknown as SessionHandle;

function makeCtx(overrides: Partial<ConnectorContext> = {}): {
  ctx: ConnectorContext;
  events: JobEvent[];
} {
  const events: JobEvent[] = [];
  const ctx: ConnectorContext = {
    browser: { launch: async () => fakeSession, close: async () => {} },
    captcha: new NullCaptchaSolver(),
    totp: () => "123456",
    emit: (e) => events.push(e),
    log: createLogger({ sink: () => {} }),
    ...overrides,
  };
  return { ctx, events };
}

function fakeDriver(overrides: Partial<EpicPageDriver>): EpicPageDriver {
  return {
    applyCookies: async () => {},
    isAuthenticated: async () => true,
    loginWithPassword: async () => ({ authenticated: true }),
    listClaimableGames: async () => [],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "EmptyProfile",
    getCookies: async () => [],
    goto: async () => {},
    ...overrides,
  };
}

const sessionInput: AuthInput = { method: "session_import", cookies: [] };
const fp = defaultFingerprint();

describe("EpicConnector.claim", () => {
  it("claims an available free game", async () => {
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({ listClaimableGames: async () => [{ title: "Game X", url: "https://store.epicgames.com/p/x" }], claimGame: async () => ({ claimed: true }) }),
    });
    const { ctx } = makeCtx();
    const res = await connector.claim(sessionInput, fp, {},ctx);
    expect(res.outcome).toBe("claimed");
    expect(res.summary).toContain("Game X");
  });

  it("returns nothing_to_claim when no games are available", async () => {
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ listClaimableGames: async () => [] }),
    });
    const res = await connector.claim(sessionInput, fp, {},makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
  });

  it("returns reauth_needed when the session is no longer authenticated", async () => {
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ isAuthenticated: async () => false }),
    });
    const res = await connector.claim(sessionInput, fp, {},makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
  });

  it("auto-solves a captcha then claims", async () => {
    let calls = 0;
    const solver: CaptchaSolver = { solve: async () => "TOKEN" };
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [{ title: "Game X", url: "https://store.epicgames.com/p/x" }],
          claimGame: async (_t, token) => {
            calls += 1;
            // First call reports captcha; retry with a token succeeds.
            return token ? { claimed: true } : { claimed: false, captcha: true };
          },
        }),
    });
    const res = await connector.claim(sessionInput, fp, {},makeCtx({ captcha: solver }).ctx);
    expect(res.outcome).toBe("claimed");
    expect(calls).toBe(2);
  });

  it("emits requires_human_action and fails when captcha cannot be auto-solved", async () => {
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [{ title: "Game X", url: "https://store.epicgames.com/p/x" }],
          claimGame: async () => ({ claimed: false, captcha: true }),
        }),
    });
    const { ctx, events } = makeCtx(); // NullCaptchaSolver → returns null
    const res = await connector.claim(sessionInput, fp, {},ctx);
    expect(res.outcome).toBe("requires_human_action");
    expect(events.some((e) => e.type === "requires_human_action")).toBe(true);
  });

  it("closes the browser session after claiming", async () => {
    const close = vi.fn(async () => {});
    const connector = new EpicConnector({ createDriver: () => fakeDriver({}) });
    await connector.claim(sessionInput, fp, {},makeCtx({
      browser: { launch: async () => fakeSession, close },
    }).ctx);
    expect(close).toHaveBeenCalledOnce();
  });
});
