import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { EpicConnector } from "../src/epic/index.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import { PlaywrightEpicDriver, type EpicPageDriver, type EpicSignInCheck } from "../src/epic/driver.js";
import type { AuthInput, ConnectorContext, JobEvent, SessionHandle } from "../src/connector.js";

const SIGNED_IN: EpicSignInCheck = { state: "signed_in", path: "/account/personal", status: 200, bounced: false };
const SIGNED_OUT: EpicSignInCheck = { state: "signed_out", path: "/id/login", status: 200, bounced: false };

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
    checkSignIn: async () => SIGNED_IN,
    loginWithPassword: async () => ({ check: SIGNED_IN }),
    listClaimableGames: async () => [],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "ExampleUser",
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
      createDriver: () => fakeDriver({ checkSignIn: async () => SIGNED_OUT }),
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

  it("puts the checkout's trail in the summary and in the log, under keys the logger leaves alone", async () => {
    const trail = "clicked 'Get'; purchase window opened; no 'Add to library' or 'Place Order' button (buttons seen: Close)";
    const lines: string[] = [];
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [
            { title: "Game X", url: "https://store.epicgames.com/p/x" },
            { title: "Game Y", url: "https://store.epicgames.com/p/y" },
          ],
          claimGame: async (game) =>
            game.title === "Game X"
              ? { claimed: false, reason: trail }
              : { claimed: false, captcha: true, reason: "a captcha challenge is showing in the purchase window" },
        }),
    });
    const { ctx } = makeCtx({ log: createLogger({ sink: (l) => lines.push(l) }) });
    const res = await connector.claim(sessionInput, fp, {}, ctx);
    // Game Y's captcha hands the run over to a person; Game X's trail still went to the log first.
    expect(res.outcome).toBe("requires_human_action");
    const logged = lines.filter((l) => l.includes("epic checkout"));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("buttons seen: Close");
    expect(logged[1]).toContain("in the purchase window");
    expect(lines.join("\n")).not.toContain("[REDACTED]");
  });

  it("a failed checkout's trail is what the summary says about the game", async () => {
    const trail = "clicked 'Get'; purchase window opened; clicked 'Add to library'; no confirmation within 30 s";
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [{ title: "Game X", url: "https://store.epicgames.com/p/x" }],
          claimGame: async () => ({ claimed: false, reason: trail }),
        }),
    });
    const res = await connector.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.summary).toBe(`Found free game(s) but could not complete checkout for: Game X (${trail}).`);
  });

  it("a missing purchase button is a failure with its reason, not a game already owned", async () => {
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [{ title: "Game X", url: "https://store.epicgames.com/p/x" }],
          claimGame: async () => ({ claimed: false, reason: "no purchase button on the page" }),
        }),
    });
    const res = await connector.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("failed");
    expect(res.summary).toContain("Game X (no purchase button on the page)");
    expect(res.summary).not.toMatch(/already owned/i);
  });
});

/**
 * A product page reduced to its purchase button: `label` is the button's text, or null for a page
 * that has none. Only what claimGame touches before it would click is here.
 */
function productPage(label: string | null): SessionHandle {
  const cta = {
    first: () => cta,
    count: async () => (label === null ? 0 : 1),
    textContent: async () => label,
  };
  const page = {
    goto: async () => null,
    waitForSelector: async () => {
      if (label === null) throw new Error("Timeout 12000ms exceeded.");
    },
    locator: () => cta,
  };
  return { context: { pages: () => [page] } } as unknown as SessionHandle;
}

describe("PlaywrightEpicDriver.claimGame", () => {
  const game = { title: "Game X", url: "https://store.epicgames.com/en-US/p/x" };

  it("reports a page without a purchase button as such, not as owned", async () => {
    const res = await new PlaywrightEpicDriver(productPage(null)).claimGame(game);
    expect(res).toEqual({ claimed: false, reason: "no purchase button on the page" });
    expect(res.alreadyOwned).toBeUndefined();
  });

  it("still recognises a game that is genuinely in the library", async () => {
    const res = await new PlaywrightEpicDriver(productPage("In Library")).claimGame(game);
    expect(res).toEqual({ claimed: false, alreadyOwned: true });
  });
});
