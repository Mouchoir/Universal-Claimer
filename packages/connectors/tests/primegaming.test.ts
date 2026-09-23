import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger, type CaptchaSolver } from "@uc/core";
import { PrimeGamingConnector, reauthSummary } from "../src/primegaming/index.js";
import {
  PlaywrightPrimeGamingDriver,
  absoluteOfferUrl,
  amazonMarketplace,
  cleanOfferTitle,
  isAmazonAuthCookie,
  platformFromOfferUrl,
  signedInMarketplaces,
  type AuthReport,
  type PrimeGamingPageDriver,
} from "../src/primegaming/driver.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import type {
  AuthInput,
  BrowserCookie,
  ConnectorContext,
  JobEvent,
  SessionHandle,
} from "../src/connector.js";

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
    authReport: async () => ({ marketplaces: [], attempts: [] }),
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

// --- Marketplaces -------------------------------------------------------------------------------

/** Unix seconds, as cookie expiries are written. */
const FUTURE = 4_102_444_800; // 2100-01-01
const PAST = 946_684_800; // 2000-01-01
const NOW_MS = Date.UTC(2026, 0, 1);

/** Advice to sign in on luna.amazon.com, which an account from another marketplace must never get. */
const SIGN_IN_ON_COM = /sign in (again )?on luna\.amazon\.com/i;

function cookie(name: string, domain: string, expires?: number, value = "opaque-value"): BrowserCookie {
  return { name, value, domain, path: "/", ...(expires !== undefined ? { expires } : {}) };
}

describe("amazonMarketplace", () => {
  it("reads the marketplace off a cookie domain, whatever the subdomain", () => {
    expect(amazonMarketplace(".amazon.fr")).toBe("amazon.fr");
    expect(amazonMarketplace("luna.amazon.co.uk")).toBe("amazon.co.uk");
    expect(amazonMarketplace("www.amazon.com.be")).toBe("amazon.com.be");
    expect(amazonMarketplace(".amazon.co.jp")).toBe("amazon.co.jp");
    expect(amazonMarketplace("gaming.amazon.com")).toBe("amazon.com");
  });

  it("returns null for domains that are not an Amazon marketplace", () => {
    expect(amazonMarketplace(".example.com")).toBeNull();
    expect(amazonMarketplace("notamazon.org")).toBeNull();
    expect(amazonMarketplace("amazon.example.org")).toBeNull();
    expect(amazonMarketplace("")).toBeNull();
  });
});

describe("signedInMarketplaces", () => {
  it("finds a French account signed in only on amazon.fr", () => {
    const jar = [cookie("at-acbfr", ".amazon.fr", FUTURE), cookie("session-id", ".amazon.fr", FUTURE)];
    expect(signedInMarketplaces(jar, NOW_MS)).toEqual(["amazon.fr"]);
  });

  it("orders several sign-ins freshest first, a session cookie counting as fresh", () => {
    const jar = [cookie("at-main", ".amazon.com", FUTURE - 100), cookie("at-acbfr", ".amazon.fr", FUTURE)];
    expect(signedInMarketplaces(jar, NOW_MS)).toEqual(["amazon.fr", "amazon.com"]);
    const withSession = [cookie("at-acbfr", ".amazon.fr", FUTURE), cookie("sess-at-main", ".amazon.com")];
    expect(signedInMarketplaces(withSession, NOW_MS)).toEqual(["amazon.com", "amazon.fr"]);
  });

  it("finds an account signed in only on amazon.com", () => {
    expect(signedInMarketplaces([cookie("at-main", ".amazon.com", FUTURE)], NOW_MS)).toEqual(["amazon.com"]);
  });

  it("finds nothing in a jar without an Amazon auth cookie", () => {
    const jar = [cookie("session-id", ".amazon.fr", FUTURE), cookie("ubid-main", ".amazon.com", FUTURE)];
    expect(signedInMarketplaces(jar, NOW_MS)).toEqual([]);
    expect(signedInMarketplaces([], NOW_MS)).toEqual([]);
  });

  it("lists every marketplace once when signed in on amazon.fr and amazon.de", () => {
    const jar = [
      cookie("at-acbde", ".amazon.de", FUTURE - 10),
      cookie("at-acbfr", ".amazon.fr", FUTURE),
      cookie("sess-at-acbfr", ".amazon.fr", FUTURE - 20),
    ];
    expect(signedInMarketplaces(jar, NOW_MS)).toEqual(["amazon.fr", "amazon.de"]);
  });

  it("ignores an expired or empty auth cookie: a lapsed sign-in proves nothing", () => {
    const jar = [cookie("at-acbfr", ".amazon.fr", PAST), cookie("at-acbde", ".amazon.de", FUTURE, "")];
    expect(signedInMarketplaces(jar, NOW_MS)).toEqual([]);
  });

  it("ignores auth-looking cookies outside Amazon", () => {
    expect(signedInMarketplaces([cookie("at-main", ".example.com", FUTURE)], NOW_MS)).toEqual([]);
  });
});

/**
 * A minimal stand-in for the Playwright page, so the real driver's sign-in resolver runs as
 * written. `routes` maps each host the driver may request to the host Amazon serves for it (a
 * missing host does not resolve); `signedInOn` lists the hosts that show the account signed in;
 * `status` gives a served host an HTTP status other than 200. Like Amazon's, an error page has
 * no sign-in button, which is exactly what makes it look signed in to a careless check.
 */
function fakeAmazon(opts: {
  routes: Record<string, string>;
  signedInOn?: string[];
  status?: Record<string, number>;
  start?: string;
}) {
  const visits: string[] = [];
  const added: BrowserCookie[] = [];
  let current = opts.start ?? "about:blank";
  const signedInOn = new Set(opts.signedInOn ?? []);
  const statusOf = (host: string) => opts.status?.[host] ?? 200;
  const showsSignInButton = () => {
    const host = new URL(current).host;
    return statusOf(host) < 400 && !signedInOn.has(host);
  };
  const page = {
    url: () => current,
    goto: async (url: string) => {
      visits.push(url);
      const target = new URL(url);
      const served = opts.routes[target.host];
      if (!served) {
        throw new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}\nCall log:\n  - navigating to "${url}"`);
      }
      current = new URL(target.pathname, `https://${served}`).href;
      const status = statusOf(served);
      return { status: () => status, ok: () => status >= 200 && status < 300 };
    },
    reload: async () => null,
    waitForTimeout: async () => {},
    waitForSelector: async () => null,
    evaluate: async () => [],
    locator: (selector: string) => {
      const count = async () => (selector.includes("sign-in-button") && showsSignInButton() ? 1 : 0);
      return { count, first: () => ({ count, textContent: async () => null }) };
    },
  };
  const context = {
    pages: () => [page],
    addCookies: async (cookies: BrowserCookie[]) => void added.push(...cookies),
    cookies: async () => [],
  };
  return { session: { context } as unknown as SessionHandle, visits, added };
}

describe("PlaywrightPrimeGamingDriver sign-in resolution", () => {
  it("keeps the old check when the entry point is signed in, and lists on that Luna host", async () => {
    // A .com identity is routed by Amazon to the account's own Luna host.
    const amazon = fakeAmazon({
      routes: { "gaming.amazon.com": "luna.amazon.fr", "luna.amazon.fr": "luna.amazon.fr" },
      signedInOn: ["luna.amazon.fr"],
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([cookie("at-main", ".amazon.com", FUTURE)]);

    expect(await driver.isAuthenticated()).toBe(true);
    const report = await driver.authReport();
    expect(report.marketplaces).toEqual(["amazon.com"]);
    expect(report.attempts).toEqual([
      { requested: "gaming.amazon.com", served: "luna.amazon.fr", signedIn: true },
    ]);
    await driver.listClaimableGames();
    expect(amazon.visits).toEqual(["https://gaming.amazon.com/home", "https://luna.amazon.fr/claims/home"]);
  });

  it("finds a French account on luna.amazon.fr after gaming.amazon.com served it signed out", async () => {
    const amazon = fakeAmazon({
      routes: { "gaming.amazon.com": "luna.amazon.com", "luna.amazon.fr": "luna.amazon.fr" },
      signedInOn: ["luna.amazon.fr"],
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([cookie("at-acbfr", ".amazon.fr", FUTURE), cookie("session-id", ".amazon.fr", FUTURE)]);

    expect(await driver.isAuthenticated()).toBe(true);
    expect((await driver.authReport()).attempts).toEqual([
      { requested: "gaming.amazon.com", served: "luna.amazon.com", signedIn: false },
      { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: true },
    ]);
    // Anonymous luna.amazon.com still renders claim cards: listing must not go back there.
    await driver.listClaimableGames();
    expect(amazon.visits.at(-1)).toBe("https://luna.amazon.fr/claims/home");
  });

  it("hands every cookie to the browser, including marketplaces without an auth cookie", async () => {
    const amazon = fakeAmazon({ routes: {} });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    const jar = [cookie("at-acbfr", ".amazon.fr", FUTURE), cookie("session-id", ".amazon.de", FUTURE)];
    await driver.applyCookies(jar);
    expect(amazon.added.map((c) => c.domain)).toEqual([".amazon.fr", ".amazon.de"]);
  });

  it("moves on when a marketplace has no Luna host (the name does not resolve)", async () => {
    const amazon = fakeAmazon({
      routes: { "gaming.amazon.com": "luna.amazon.com", "luna.amazon.fr": "luna.amazon.fr" },
      signedInOn: ["luna.amazon.fr"],
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([cookie("at-acbjp", ".amazon.co.jp"), cookie("at-acbfr", ".amazon.fr", FUTURE)]);

    expect(await driver.isAuthenticated()).toBe(true);
    const [, jp, fr] = (await driver.authReport()).attempts;
    expect(jp).toMatchObject({ requested: "luna.amazon.co.jp", served: "", signedIn: false });
    expect(jp?.navError).toContain("ERR_NAME_NOT_RESOLVED");
    expect(jp?.navError).not.toContain("Call log");
    expect(fr).toEqual({ requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: true });
  });

  it("does not read a Luna host answering with an HTTP error as signed in", async () => {
    // A 5xx or a geo-block page has no sign-in button either, and goto does not throw on it.
    const amazon = fakeAmazon({
      routes: {
        "gaming.amazon.com": "luna.amazon.com",
        "luna.amazon.fr": "luna.amazon.fr",
        "luna.amazon.de": "luna.amazon.de",
      },
      signedInOn: ["luna.amazon.de"],
      status: { "luna.amazon.fr": 503 },
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([cookie("at-acbfr", ".amazon.fr", FUTURE), cookie("at-acbde", ".amazon.de", FUTURE - 10)]);

    expect(await driver.isAuthenticated()).toBe(true);
    expect((await driver.authReport()).attempts).toEqual([
      { requested: "gaming.amazon.com", served: "luna.amazon.com", signedIn: false },
      { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: false, navError: "HTTP 503" },
      { requested: "luna.amazon.de", served: "luna.amazon.de", signedIn: true },
    ]);
    await driver.listClaimableGames();
    expect(amazon.visits.at(-1)).toBe("https://luna.amazon.de/claims/home");
  });

  it("lets the routed host's verdict stand instead of trying luna.amazon.com", async () => {
    // Amazon routed the .com identity to luna.amazon.fr, signed out there. luna.amazon.com would
    // accept the same cookies, but it is not where this account's offers are claimed.
    const amazon = fakeAmazon({
      routes: {
        "gaming.amazon.com": "luna.amazon.fr",
        "luna.amazon.com": "luna.amazon.com",
        "luna.amazon.de": "luna.amazon.de",
      },
      signedInOn: ["luna.amazon.com"],
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([cookie("at-main", ".amazon.com", FUTURE), cookie("at-acbde", ".amazon.de", FUTURE - 10)]);

    expect(await driver.isAuthenticated()).toBe(false);
    // Other marketplaces are still tried; only the .com fallback is left out.
    expect(amazon.visits).toEqual(["https://gaming.amazon.com/home", "https://luna.amazon.de/claims/home"]);
    const report = await driver.authReport();
    expect(report.attempts).toEqual([
      { requested: "gaming.amazon.com", served: "luna.amazon.fr", signedIn: false },
      { requested: "luna.amazon.de", served: "luna.amazon.de", signedIn: false },
    ]);
    // The message agrees with the check: sign in where Amazon routed the account.
    const summary = reauthSummary(report);
    expect(summary).toContain("routed the amazon.com sign-in to luna.amazon.fr");
    expect(summary).toContain("Amazon routes this account to luna.amazon.fr");
    expect(summary).not.toMatch(SIGN_IN_ON_COM);
  });

  it("does not ask again for a host that was already served", async () => {
    const amazon = fakeAmazon({ routes: { "gaming.amazon.com": "luna.amazon.com" } });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([cookie("at-main", ".amazon.com", FUTURE)]);

    expect(await driver.isAuthenticated()).toBe(false);
    expect(amazon.visits).toEqual(["https://gaming.amazon.com/home"]);
  });

  it("records a geo-redirect and does not read a non-Luna page as signed in", async () => {
    const amazon = fakeAmazon({
      routes: {
        "gaming.amazon.com": "luna.amazon.com",
        "luna.amazon.de": "luna.amazon.fr",
        // Amazon's sign-in form has no sign-in button; that must not pass for signed in.
        "luna.amazon.it": "www.amazon.it",
      },
      signedInOn: ["www.amazon.it"],
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    await driver.applyCookies([
      cookie("at-acbde", ".amazon.de", FUTURE),
      cookie("at-acbit", ".amazon.it", FUTURE - 10),
      cookie("at-acbfr", ".amazon.fr", FUTURE - 20),
    ]);

    expect(await driver.isAuthenticated()).toBe(false);
    expect((await driver.authReport()).attempts).toEqual([
      { requested: "gaming.amazon.com", served: "luna.amazon.com", signedIn: false },
      { requested: "luna.amazon.de", served: "luna.amazon.fr", signedIn: false },
      { requested: "luna.amazon.it", served: "www.amazon.it", signedIn: false },
      // luna.amazon.fr was already served (with the .fr cookies) above, so it is not asked again.
    ]);
    // Nothing signed in: listing falls back to the entry point, as it always did.
    await driver.listClaimableGames();
    expect(amazon.visits.at(-1)).toBe("https://gaming.amazon.com/home");
  });

  it("never navigates away from a page already on Amazon without imported cookies", async () => {
    // Assisted login polls isAuthenticated on the operator's own page: it must stay put.
    const amazon = fakeAmazon({ routes: {}, start: "https://luna.amazon.fr/claims/home" });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    expect(await driver.isAuthenticated()).toBe(false);
    expect(amazon.visits).toEqual([]);
    expect((await driver.authReport()).attempts).toEqual([
      { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: false },
    ]);
  });

  it("lists through the entry point when it was signed in without reaching Luna", async () => {
    const amazon = fakeAmazon({
      routes: { "gaming.amazon.com": "gaming.amazon.com" },
      signedInOn: ["gaming.amazon.com"],
    });
    const driver = new PlaywrightPrimeGamingDriver(amazon.session);
    expect(await driver.isAuthenticated()).toBe(true);
    await driver.listClaimableGames();
    expect(amazon.visits).toEqual(["https://gaming.amazon.com/home", "https://gaming.amazon.com/home"]);
  });
});

function signedOut(report: AuthReport): PrimeGamingPageDriver {
  return fakeDriver({ isAuthenticated: async () => false, authReport: async () => report });
}

async function reauth(report: AuthReport): Promise<string> {
  const c = new PrimeGamingConnector({ createDriver: () => signedOut(report) });
  const res = await c.claim(sessionInput, fp, {}, makeCtx().ctx);
  expect(res.outcome).toBe("reauth_needed");
  return res.summary;
}

const entryToCom = { requested: "gaming.amazon.com", served: "luna.amazon.com", signedIn: false };

describe("PrimeGamingConnector reauth_needed summary", () => {
  it("says so when the session holds no Amazon sign-in at all", async () => {
    const summary = await reauth({ marketplaces: [], attempts: [entryToCom] });
    expect(summary).toContain("No Amazon sign-in found");
    expect(summary).toContain("own marketplace's Luna page");
    expect(summary).toContain("Tried: gaming.amazon.com (served luna.amazon.com).");
  });

  it("names the account's own Luna host, never luna.amazon.com, for an amazon.fr sign-in", async () => {
    const summary = await reauth({
      marketplaces: ["amazon.fr"],
      attempts: [entryToCom, { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: false }],
    });
    expect(summary).toContain("Signed in on amazon.fr, but luna.amazon.fr showed the account signed out.");
    expect(summary).toContain("expired or Amazon rejected it");
    expect(summary).toContain("sign in again on luna.amazon.fr");
    expect(summary).toContain("Tried: gaming.amazon.com (served luna.amazon.com), luna.amazon.fr.");
    expect(summary).not.toMatch(SIGN_IN_ON_COM);
  });

  it("covers every marketplace the session is signed in on, redirects included", async () => {
    const summary = await reauth({
      marketplaces: ["amazon.fr", "amazon.de"],
      attempts: [
        entryToCom,
        { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: false },
        { requested: "luna.amazon.de", served: "luna.amazon.fr", signedIn: false },
      ],
    });
    expect(summary).toContain("Signed in on amazon.fr and amazon.de");
    expect(summary).toContain("luna.amazon.de redirected to luna.amazon.fr");
    expect(summary).toContain("sign in again on luna.amazon.fr and luna.amazon.de");
    expect(summary).not.toMatch(SIGN_IN_ON_COM);
  });

  it("says when the marketplace's Luna host could not be reached", async () => {
    const summary = await reauth({
      marketplaces: ["amazon.co.jp"],
      attempts: [
        entryToCom,
        { requested: "luna.amazon.co.jp", served: "", signedIn: false, navError: "net::ERR_NAME_NOT_RESOLVED" },
      ],
    });
    expect(summary).toContain("luna.amazon.co.jp could not be reached");
    expect(summary).toContain("nowhere to claim from");
    // Not a dead end: gaming.amazon.com still routes an account it can identify from .com cookies.
    expect(summary).toContain("sign in through gaming.amazon.com in your browser");
    expect(summary).toContain("luna.amazon.co.jp (unreachable)");
    expect(summary).not.toMatch(SIGN_IN_ON_COM);
  });

  it("reports a Luna host answering with an HTTP error as such, not as signed out", async () => {
    const summary = await reauth({
      marketplaces: ["amazon.fr"],
      attempts: [
        entryToCom,
        { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: false, navError: "HTTP 503" },
      ],
    });
    expect(summary).toContain("luna.amazon.fr answered HTTP 503");
    expect(summary).not.toContain("showed the account signed out");
    expect(summary).toContain("sign in through gaming.amazon.com");
    expect(summary).toContain("Tried: gaming.amazon.com (served luna.amazon.com), luna.amazon.fr (HTTP 503).");
  });

  it("asks for a .com sign-in only when .com is the account's marketplace", async () => {
    const com = await reauth({ marketplaces: ["amazon.com"], attempts: [entryToCom] });
    expect(com).toContain("luna.amazon.com showed the account signed out");
    expect(com).toContain("sign in again on luna.amazon.com");

    // Amazon routed the .com identity to luna.amazon.fr: that is where the account lives.
    const routed = await reauth({
      marketplaces: ["amazon.com"],
      attempts: [
        { requested: "gaming.amazon.com", served: "luna.amazon.fr", signedIn: false },
        { requested: "luna.amazon.com", served: "luna.amazon.com", signedIn: false },
      ],
    });
    expect(routed).toContain("Amazon routes this account to luna.amazon.fr");
    expect(routed).toContain("sign in on luna.amazon.fr");
    expect(routed).not.toMatch(SIGN_IN_ON_COM);

    // Signed in on amazon.fr as well: the check no longer tries luna.amazon.com after that
    // redirect, and the message must not ask for a .com sign-in it never looked for.
    const both = await reauth({
      marketplaces: ["amazon.com", "amazon.fr"],
      attempts: [{ requested: "gaming.amazon.com", served: "luna.amazon.fr", signedIn: false }],
    });
    expect(both).not.toContain("luna.amazon.com was not checked");
    expect(both).toContain("sign in again on luna.amazon.fr in your browser");
    expect(both).not.toMatch(SIGN_IN_ON_COM);
  });

  it("is also the reason a session import is refused", async () => {
    const report: AuthReport = {
      marketplaces: ["amazon.fr"],
      attempts: [entryToCom, { requested: "luna.amazon.fr", served: "luna.amazon.fr", signedIn: false }],
    };
    const c = new PrimeGamingConnector({ createDriver: () => signedOut(report) });
    const res = await c.authenticate(sessionInput, makeCtx().ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(reauthSummary(report));
    expect(res.reason).toContain("sign in again on luna.amazon.fr");
  });

  it("claims end to end on the account's own Luna host, logging host names but no cookie", async () => {
    const amazon = fakeAmazon({
      routes: { "gaming.amazon.com": "luna.amazon.com", "luna.amazon.fr": "luna.amazon.fr" },
      signedInOn: ["luna.amazon.fr"],
    });
    const lines: string[] = [];
    const c = new PrimeGamingConnector({ createDriver: (s) => new PlaywrightPrimeGamingDriver(s) });
    const input: AuthInput = {
      method: "session_import",
      cookies: [cookie("at-acbfr", ".amazon.fr", FUTURE, "cookie-value-must-not-leak")],
    };
    const res = await c.claim(input, fp, {}, makeCtx({
      browser: { launch: async () => amazon.session, close: async () => {} },
      log: createLogger({ sink: (line) => lines.push(line) }),
    }).ctx);

    expect(res.outcome).toBe("nothing_to_claim");
    expect(amazon.visits.at(-1)).toBe("https://luna.amazon.fr/claims/home");
    const log = lines.join("\n");
    expect(log).toContain("prime gaming sign-in check");
    expect(log).toContain('"marketplaces":["amazon.fr"]');
    expect(log).toContain('"requested":"luna.amazon.fr"');
    expect(log).not.toContain("REDACTED");
    expect(log).not.toContain("cookie-value-must-not-leak");
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
