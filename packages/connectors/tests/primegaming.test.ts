import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { PrimeGamingConnector } from "../src/primegaming/index.js";
import {
  absoluteOfferUrl,
  cleanOfferTitle,
  isAmazonAuthCookie,
  platformFromOfferUrl,
  type PrimeGamingPageDriver,
} from "../src/primegaming/driver.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import type { AuthInput, ConnectorContext, JobEvent, SessionHandle } from "../src/connector.js";

const fakeSession = { context: {} } as unknown as SessionHandle;
const fp = defaultFingerprint();
const sessionInput: AuthInput = { method: "session_import", cookies: [] };

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

function fakeDriver(over: Partial<PrimeGamingPageDriver> = {}): PrimeGamingPageDriver {
  return {
    applyCookies: async () => {},
    isAuthenticated: async () => true,
    listClaimableGames: async () => [],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "ExampleUser",
    servedHost: async () => "gaming.amazon.com",
    getCookies: async () => [],
    goto: async () => {},
    ...over,
  };
}

const offer = { title: "Still There", url: "https://gaming.amazon.com/claims/still-there-gog/dp/x" };

describe("cleanOfferTitle", () => {
  it("prefers the card heading when present", () => {
    expect(cleanOfferTitle("Still There", "Still ThereClaim game")).toBe("Still There");
  });

  it("strips the trailing CTA when there is no heading", () => {
    expect(cleanOfferTitle("", "Still ThereClaim game")).toBe("Still There");
    expect(cleanOfferTitle("", "CyClonesObtenir le jeu")).toBe("CyClones");
  });

  it("returns an empty string for an empty card", () => {
    expect(cleanOfferTitle("", "")).toBe("");
  });
});

describe("absoluteOfferUrl", () => {
  it("keeps absolute URLs untouched", () => {
    expect(absoluteOfferUrl("https://gaming.amazon.com/x")).toBe("https://gaming.amazon.com/x");
  });

  it("resolves relative hrefs against the serving origin", () => {
    expect(absoluteOfferUrl("/claims/a/dp/b", "https://luna.amazon.com")).toBe(
      "https://luna.amazon.com/claims/a/dp/b",
    );
  });

  it("returns an empty string for a missing href", () => {
    expect(absoluteOfferUrl("")).toBe("");
  });
});

describe("PrimeGamingConnector.claim", () => {
  it("claims an available offer and reports it as an item", async () => {
    const c = new PrimeGamingConnector({
      createDriver: () => fakeDriver({ listClaimableGames: async () => [offer] }),
    });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("claimed");
    // The slug suffix (-gog) tells us where the key has to be redeemed.
    expect(res.claimedItems).toEqual([{ kind: "game", title: "Still There", platform: "GOG" }]);
    expect(res.accountFacts?.username).toBe("ExampleUser");
  });

  it("reports nothing_to_claim when no offer is listed", async () => {
    const c = new PrimeGamingConnector({ createDriver: () => fakeDriver() });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
  });

  it("treats already-owned offers as nothing to claim", async () => {
    const c = new PrimeGamingConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [offer],
          claimGame: async () => ({ claimed: false, alreadyOwned: true }),
        }),
    });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("nothing_to_claim");
    expect(res.summary).toContain("already in your library");
  });

  it("reports failure — not success — when the claim does not complete", async () => {
    const c = new PrimeGamingConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [offer],
          claimGame: async () => ({ claimed: false }),
        }),
    });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("failed");
  });

  it("returns reauth_needed when the session is not authenticated", async () => {
    const c = new PrimeGamingConnector({
      createDriver: () => fakeDriver({ isAuthenticated: async () => false }),
    });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
  });

  it("asks for human action when a challenge cannot be solved", async () => {
    const c = new PrimeGamingConnector({
      createDriver: () =>
        fakeDriver({
          listClaimableGames: async () => [offer],
          claimGame: async () => ({ claimed: false, captcha: true }),
        }),
    });
    const { ctx, events } = makeCtx(); // NullCaptchaSolver → no token
    const res = await c.claim(sessionInput, fp, {}, ctx);
    expect(res.outcome).toBe("requires_human_action");
    expect(events.some((e) => e.type === "requires_human_action")).toBe(true);
  });

  it("claims several offers in one run", async () => {
    const second = { title: "CyClones", url: "https://gaming.amazon.com/claims/cyclones/dp/y" };
    const c = new PrimeGamingConnector({
      createDriver: () => fakeDriver({ listClaimableGames: async () => [offer, second] }),
    });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.claimedItems).toHaveLength(2);
  });

  it("closes the browser session even after claiming", async () => {
    const close = vi.fn(async () => {});
    const c = new PrimeGamingConnector({ createDriver: () => fakeDriver() });
    await c.claim(sessionInput, fp, {}, makeCtx({
      browser: { launch: async () => fakeSession, close },
    }).ctx);
    expect(close).toHaveBeenCalledOnce();
  });

  it("directs password logins to session import", async () => {
    const c = new PrimeGamingConnector({ createDriver: () => fakeDriver() });
    const res = await c.authenticate(
      { method: "credential_totp", email: "a@b.c", password: "x" },
      makeCtx().ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("session import");
  });
});

describe("isAmazonAuthCookie", () => {
  it("accepts the .com auth cookie", () => {
    expect(isAmazonAuthCookie("at-main", ".amazon.com")).toBe(true);
  });

  it("accepts per-marketplace auth cookies (the reason a French account failed)", () => {
    expect(isAmazonAuthCookie("at-acbfr", ".amazon.fr")).toBe(true);
    expect(isAmazonAuthCookie("at-acbde", ".amazon.de")).toBe(true);
    expect(isAmazonAuthCookie("at-acbjp", ".amazon.co.jp")).toBe(true);
  });

  it("accepts the session-scoped variant", () => {
    expect(isAmazonAuthCookie("sess-at-main", ".amazon.com")).toBe(true);
    expect(isAmazonAuthCookie("sess-at-acbfr", ".amazon.fr")).toBe(true);
  });

  it("works on Luna and Gaming subdomains", () => {
    expect(isAmazonAuthCookie("at-acbfr", "luna.amazon.fr")).toBe(true);
    expect(isAmazonAuthCookie("at-main", "gaming.amazon.com")).toBe(true);
  });

  it("rejects non-auth Amazon cookies", () => {
    expect(isAmazonAuthCookie("session-id", ".amazon.fr")).toBe(false);
    expect(isAmazonAuthCookie("ubid-main", ".amazon.com")).toBe(false);
  });

  it("rejects auth-looking cookies from other sites", () => {
    expect(isAmazonAuthCookie("at-main", ".example.com")).toBe(false);
    expect(isAmazonAuthCookie("at-main", "notamazon.org")).toBe(false);
  });
});

describe("PrimeGamingConnector marketplace mismatch", () => {
  it("names the host that was served so the operator knows where to sign in", async () => {
    // Amazon routes Prime Gaming by region: a session valid on amazon.com can land signed-out on
    // luna.amazon.fr. The message must say which host, not just "reconnect".
    const c = new PrimeGamingConnector({
      createDriver: () =>
        fakeDriver({
          isAuthenticated: async () => false,
          servedHost: async () => "luna.amazon.fr",
        }),
    });
    const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
    expect(res.summary).toContain("luna.amazon.fr");
    expect(res.summary).toMatch(/sign in/i);
  });
});

describe("platformFromOfferUrl", () => {
  it("derives the store from the slug suffix Amazon puts in every claim URL", () => {
    const base = "https://luna.amazon.fr/claims/";
    expect(platformFromOfferUrl(`${base}framed-collection-gog/dp/x`)).toBe("GOG");
    expect(platformFromOfferUrl(`${base}lonestar-epic/dp/x`)).toBe("Epic Games Store");
    expect(platformFromOfferUrl(`${base}terraforming-mars-aga/dp/x`)).toBe("Amazon Games App");
    expect(platformFromOfferUrl(`${base}please-touch-the-artwork-legacy/dp/x`)).toBe("Legacy Games");
  });

  it("works on the gaming.amazon.com URL shape too", () => {
    expect(platformFromOfferUrl("https://gaming.amazon.com/space-grunts-2-gog/dp/y")).toBe("GOG");
  });

  it("returns undefined rather than guessing for an unknown suffix", () => {
    expect(platformFromOfferUrl("https://luna.amazon.fr/claims/some-game-unknownstore/dp/x")).toBeUndefined();
    expect(platformFromOfferUrl("https://example.com/nothing")).toBeUndefined();
    expect(platformFromOfferUrl("")).toBeUndefined();
  });
});
