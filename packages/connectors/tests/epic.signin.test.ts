import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger } from "@uc/core";
import { EpicConnector, describeAuthCookies } from "../src/epic/index.js";
import {
  PlaywrightEpicDriver,
  settleSignIn,
  wherePath,
  type EpicPageDriver,
  type EpicSignInCheck,
  type SignInProbe,
} from "../src/epic/driver.js";
import { defaultFingerprint } from "../src/fingerprint.js";
import type { AuthInput, BrowserCookie, ConnectorContext, SessionHandle } from "../src/connector.js";

const ACCOUNT = "https://www.epicgames.com/account/personal";
// The login page as Epic serves it: the redirect parameter names the account page, which must
// not be mistaken for being on it.
const LOGIN =
  "https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Faccount%2Fpersonal";

const TIMING = { bounceMs: 25_000, challengeMs: 20_000, pollMs: 500 };

/** A page whose URL and challenge state are scripted against a fake clock that sleeping advances. */
function scripted(opts: {
  url: (t: number) => string;
  challengedUntil?: number;
  /** In place of `challengedUntil`, for a challenge that only starts after the first landing. */
  challenged?: (t: number) => boolean;
  status?: number;
}): { probe: SignInProbe; elapsed: () => number } {
  let t = 0;
  return {
    probe: {
      url: () => opts.url(t),
      status: () => opts.status,
      challenged: async () =>
        opts.challenged ? opts.challenged(t) : t < (opts.challengedUntil ?? 0),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    },
    elapsed: () => t,
  };
}

describe("settleSignIn", () => {
  it("an account landing is signed in at once, with no wait", async () => {
    const { probe, elapsed } = scripted({ url: () => ACCOUNT, status: 200 });
    expect(await settleSignIn(probe, TIMING)).toEqual({
      state: "signed_in",
      path: "/account/personal",
      status: 200,
      bounced: false,
    });
    expect(elapsed()).toBe(0);
  });

  it("keeps today's pass condition: any landing but the login page passes", async () => {
    // Jars that passed before this change must still pass, wherever the account page sent them.
    const { probe } = scripted({ url: () => "https://www.epicgames.com/site/en-US/home" });
    expect((await settleSignIn(probe, TIMING)).state).toBe("signed_in");
  });

  it("a login landing that bounces back to the account page is signed in, and says so", async () => {
    // Epic's login page renewing the short-lived tokens from the longer-lived cookies.
    const { probe, elapsed } = scripted({ url: (t) => (t < 3_000 ? LOGIN : ACCOUNT) });
    const res = await settleSignIn(probe, TIMING);
    expect(res).toMatchObject({ state: "signed_in", path: "/account/personal", bounced: true });
    expect(elapsed()).toBeGreaterThanOrEqual(3_000);
    expect(elapsed()).toBeLessThan(TIMING.bounceMs);
  });

  it("a login landing that never bounces is signed out after a bounded wait, naming where it stopped", async () => {
    const { probe, elapsed } = scripted({ url: () => LOGIN });
    const res = await settleSignIn(probe, TIMING);
    expect(res).toMatchObject({ state: "signed_out", path: "/id/login", bounced: false });
    expect(elapsed()).toBe(TIMING.bounceMs);
  });

  it("leaving the login page for somewhere other than the account page is not a bounce", async () => {
    const { probe } = scripted({
      url: (t) => (t < 2_000 ? LOGIN : "https://www.epicgames.com/id/register"),
    });
    expect(await settleSignIn(probe, TIMING)).toMatchObject({
      state: "signed_out",
      path: "/id/register",
    });
  });

  it("a Cloudflare challenge that clears by itself is judged on where it lands", async () => {
    const { probe, elapsed } = scripted({ url: () => ACCOUNT, challengedUntil: 4_000 });
    expect(await settleSignIn(probe, TIMING)).toMatchObject({ state: "signed_in", bounced: false });
    expect(elapsed()).toBeGreaterThanOrEqual(4_000);
  });

  it("a Cloudflare challenge that does not clear is blocked, not signed in and not signed out", async () => {
    // It keeps the account URL, which is exactly why it used to read as signed in.
    const { probe, elapsed } = scripted({ url: () => ACCOUNT, challengedUntil: Infinity, status: 403 });
    expect(await settleSignIn(probe, TIMING)).toEqual({
      state: "blocked",
      path: "/account/personal",
      status: 403,
      bounced: false,
    });
    expect(elapsed()).toBe(TIMING.challengeMs);
  });

  it("a bounce onto a challenged account page gets the challenge wait, and is blocked if it stays", async () => {
    // The account document the login page sends the browser back to can be challenged like the
    // first one; on the URL alone it would read as signed in.
    const { probe, elapsed } = scripted({
      url: (t) => (t < 3_000 ? LOGIN : ACCOUNT),
      challenged: (t) => t >= 3_000,
      status: 403,
    });
    expect(await settleSignIn(probe, TIMING)).toEqual({
      state: "blocked",
      path: "/account/personal",
      status: 403,
      bounced: true,
    });
    expect(elapsed()).toBe(3_000 + TIMING.challengeMs);
  });

  it("a bounce onto a challenge that clears is signed in through the bounce", async () => {
    const { probe, elapsed } = scripted({
      url: (t) => (t < 3_000 ? LOGIN : ACCOUNT),
      challenged: (t) => t >= 3_000 && t < 7_000,
    });
    expect(await settleSignIn(probe, TIMING)).toMatchObject({
      state: "signed_in",
      path: "/account/personal",
      bounced: true,
    });
    expect(elapsed()).toBeGreaterThanOrEqual(7_000);
  });

  it("keeps the host in the path when it is not www.epicgames.com, and never the query", () => {
    expect(wherePath(LOGIN)).toBe("/id/login");
    expect(wherePath("https://id.epicgames.com/login?client=x")).toBe("id.epicgames.com/login");
    expect(wherePath("about:blank")).toBe("about:blank");
  });
});

// --- The connector's side: what each verdict becomes --------------------------------------------

const fakeSession = { context: {} } as unknown as SessionHandle;
const sessionInput: AuthInput = { method: "session_import", cookies: [] };
const fp = defaultFingerprint();

const FUTURE = Math.floor(Date.now() / 1000) + 30 * 86_400;
const PAST = Math.floor(Date.now() / 1000) - 3_600;

/** Values are distinctive so a leak into a summary or a log line cannot go unnoticed. */
const jar: BrowserCookie[] = [
  { name: "EPIC_SESSION_AP", value: "leak-check-session-ap", domain: "www.epicgames.com", path: "/", expires: FUTURE },
  { name: "EPIC_SSO_RM", value: "leak-check-sso-rm", domain: ".epicgames.com", path: "/", expires: FUTURE },
  { name: "EPIC_DEVICE", value: "leak-check-device", domain: ".epicgames.com", path: "/", expires: -1 },
  { name: "EPIC_BEARER_TOKEN", value: "leak-check-bearer", domain: ".epicgames.com", path: "/", expires: PAST },
  { name: "unrelated", value: "leak-check-unrelated", domain: ".epicgames.com", path: "/", expires: FUTURE },
];

function check(over: Partial<EpicSignInCheck>): EpicSignInCheck {
  return { state: "signed_in", path: "/account/personal", status: 200, bounced: false, ...over };
}

function fakeDriver(over: Partial<EpicPageDriver>): EpicPageDriver {
  return {
    applyCookies: async () => {},
    checkSignIn: async () => check({}),
    loginWithPassword: async () => ({ check: check({}) }),
    listClaimableGames: async () => [{ title: "Game X", url: "https://store.epicgames.com/p/x" }],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "ExampleUser",
    getCookies: async () => jar,
    goto: async () => {},
    ...over,
  };
}

function makeCtx(over: Partial<ConnectorContext> = {}): { ctx: ConnectorContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: ConnectorContext = {
    browser: { launch: async () => fakeSession, close: async () => {} },
    captcha: new NullCaptchaSolver(),
    totp: () => "123456",
    emit: () => {},
    log: createLogger({ sink: (line) => lines.push(line) }),
    ...over,
  };
  return { ctx, lines };
}

describe("EpicConnector sign-in verdicts", () => {
  it("signed in → claims, and persists the session", async () => {
    const persist = vi.fn(async () => {});
    const connector = new EpicConnector({ createDriver: () => fakeDriver({}) });
    const res = await connector.claim(sessionInput, fp, {}, makeCtx({ persistRefreshedSession: persist }).ctx);
    expect(res.outcome).toBe("claimed");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("bounced → signed in, claims, and persists the cookies the login page just renewed", async () => {
    const persist = vi.fn<(cookies: BrowserCookie[]) => Promise<void>>(async () => {});
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ checkSignIn: async () => check({ bounced: true }) }),
    });
    const { ctx, lines } = makeCtx({ persistRefreshedSession: persist });
    const res = await connector.claim(sessionInput, fp, {}, ctx);
    expect(res.outcome).toBe("claimed");
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]![0]).toBe(jar);
    // The log says it bounced, so a renewal is visible in the worker output.
    expect(lines.some((l) => l.includes('"bounced":true'))).toBe(true);
  });

  it("signed out after the wait → reauth_needed, naming where it stopped and the cookie states", async () => {
    const persist = vi.fn(async () => {});
    const listClaimableGames = vi.fn(async () => []);
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          checkSignIn: async () => check({ state: "signed_out", path: "/id/login" }),
          listClaimableGames,
        }),
    });
    const { ctx } = makeCtx({ persistRefreshedSession: persist });
    const res = await connector.claim(sessionInput, fp, {}, ctx);
    expect(res.outcome).toBe("reauth_needed");
    expect(res.summary).toContain("stopped at /id/login");
    expect(res.summary).toContain("EPIC_SESSION_AP (valid)");
    expect(res.summary).toContain("EPIC_SSO_RM (valid)");
    expect(res.summary).toContain("EPIC_DEVICE (session)");
    expect(res.summary).toContain("EPIC_BEARER_TOKEN (expired)");
    expect(res.summary).toMatch(/missing: EPIC_SSO\b/);
    // Nothing is claimed and nothing logged-out is saved over the stored session.
    expect(listClaimableGames).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("blocked → failed with a summary that names the challenge, and no reconnect", async () => {
    const persist = vi.fn(async () => {});
    const listClaimableGames = vi.fn(async () => []);
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          checkSignIn: async () => check({ state: "blocked", status: 403 }),
          listClaimableGames,
        }),
    });
    const res = await connector.claim(sessionInput, fp, {}, makeCtx({ persistRefreshedSession: persist }).ctx);
    expect(res).toEqual({
      outcome: "failed",
      summary: "Blocked by a Cloudflare challenge at /account/personal.",
    });
    expect(listClaimableGames).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("never puts a cookie value in the summary or the log", async () => {
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ checkSignIn: async () => check({ state: "signed_out", path: "/id/login" }) }),
    });
    const { ctx, lines } = makeCtx();
    const res = await connector.claim(sessionInput, fp, {}, ctx);
    const everything = [res.summary, ...lines].join("\n");
    expect(everything).not.toContain("leak-check");
    expect(res.summary).not.toContain("unrelated");
  });

  it("session import on connect reports the same detail", async () => {
    const signedOut = new EpicConnector({
      createDriver: () => fakeDriver({ checkSignIn: async () => check({ state: "signed_out", path: "/id/login" }) }),
    });
    const blocked = new EpicConnector({
      createDriver: () => fakeDriver({ checkSignIn: async () => check({ state: "blocked" }) }),
    });
    const out = await signedOut.authenticate(sessionInput, makeCtx().ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("stopped at /id/login");
    expect(out.reason).not.toContain("leak-check");
    expect((await blocked.authenticate(sessionInput, makeCtx().ctx)).reason).toMatch(/^Blocked by a Cloudflare challenge/);
  });
});

describe("EpicConnector password login verdicts", () => {
  const passwordInput: AuthInput = { method: "credential_totp", email: "a@b.com", password: "pw" };

  it("connect: a login that ends on a challenge is blocked, not 'login failed'", async () => {
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({ loginWithPassword: async () => ({ check: check({ state: "blocked" }) }) }),
    });
    expect(await connector.authenticate(passwordInput, makeCtx().ctx)).toMatchObject({
      ok: false,
      reason: "Blocked by a Cloudflare challenge at /account/personal.",
    });
  });

  it("connect: a login that ends signed out names where it stopped and the cookie states", async () => {
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          loginWithPassword: async () => ({ check: check({ state: "signed_out", path: "/id/login" }) }),
        }),
    });
    const out = await connector.authenticate(passwordInput, makeCtx().ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/^login failed \(check credentials \/ TOTP\): it stopped at \/id\/login/);
    expect(out.reason).toContain("EPIC_SESSION_AP (valid)");
    expect(out.reason).not.toContain("leak-check");
  });

  it("claim: goes on the login's own check, without opening the account page again", async () => {
    const checkSignIn = vi.fn(async () => check({}));
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({ checkSignIn, loginWithPassword: async () => ({ check: check({ bounced: true }) }) }),
    });
    const { ctx, lines } = makeCtx();
    expect((await connector.claim(passwordInput, fp, {}, ctx)).outcome).toBe("claimed");
    expect(checkSignIn).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('"bounced":true'))).toBe(true);
  });

  it("claim: a login that ends on a challenge fails as blocked", async () => {
    const checkSignIn = vi.fn(async () => check({}));
    const listClaimableGames = vi.fn(async () => []);
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          checkSignIn,
          listClaimableGames,
          loginWithPassword: async () => ({ check: check({ state: "blocked", status: 403 }) }),
        }),
    });
    expect(await connector.claim(passwordInput, fp, {}, makeCtx().ctx)).toEqual({
      outcome: "failed",
      summary: "Blocked by a Cloudflare challenge at /account/personal.",
    });
    expect(checkSignIn).not.toHaveBeenCalled();
    expect(listClaimableGames).not.toHaveBeenCalled();
  });

  it("claim: a login that ends signed out needs a reconnect", async () => {
    const checkSignIn = vi.fn(async () => check({}));
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          checkSignIn,
          loginWithPassword: async () => ({ check: check({ state: "signed_out", path: "/id/login" }) }),
        }),
    });
    const res = await connector.claim(passwordInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
    expect(res.summary).toContain("stopped at /id/login");
    expect(checkSignIn).not.toHaveBeenCalled();
  });

  it("claim: a captcha at login needs a reconnect by session import, and runs no check", async () => {
    const checkSignIn = vi.fn(async () => check({}));
    const listClaimableGames = vi.fn(async () => []);
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({ checkSignIn, listClaimableGames, loginWithPassword: async () => ({ captcha: true }) }),
    });
    const res = await connector.claim(passwordInput, fp, {}, makeCtx().ctx);
    expect(res.outcome).toBe("reauth_needed");
    expect(res.summary).toMatch(/captcha/);
    expect(res.summary).toMatch(/session import/);
    expect(checkSignIn).not.toHaveBeenCalled();
    expect(listClaimableGames).not.toHaveBeenCalled();
  });
});

describe("describeAuthCookies", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const at = (iso: string) => Date.parse(iso) / 1000;

  it("lists present cookies with their expiry state and the missing ones by name", () => {
    expect(
      describeAuthCookies(
        [
          { name: "EPIC_SSO", value: "x", domain: ".epicgames.com", path: "/", expires: at("2026-08-31T20:00:00Z") },
          { name: "EPIC_SSO_RM", value: "x", domain: ".epicgames.com", path: "/", expires: at("2026-10-01T00:00:00Z") },
          { name: "EPIC_DEVICE", value: "x", domain: ".epicgames.com", path: "/" },
        ],
        now,
      ),
    ).toBe(
      "Auth cookies present: EPIC_SSO (expired), EPIC_SSO_RM (valid), EPIC_DEVICE (session); " +
        "missing: EPIC_BEARER_TOKEN, EPIC_SESSION_AP.",
    );
  });

  it("takes the best state when a name is set on more than one host", () => {
    expect(
      describeAuthCookies(
        [
          { name: "EPIC_SESSION_AP", value: "x", domain: "store.epicgames.com", path: "/", expires: at("2026-08-01T00:00:00Z") },
          { name: "EPIC_SESSION_AP", value: "x", domain: "www.epicgames.com", path: "/", expires: at("2026-10-01T00:00:00Z") },
        ],
        now,
      ),
    ).toContain("EPIC_SESSION_AP (valid)");
  });

  it("says so when the browser holds none of them", () => {
    expect(describeAuthCookies([], now)).toBe(
      "Auth cookies present: none; missing: EPIC_SSO, EPIC_BEARER_TOKEN, EPIC_SESSION_AP, EPIC_SSO_RM, EPIC_DEVICE.",
    );
  });
});

// --- The Playwright glue, against a page that only has what the check touches -------------------

/**
 * A bare page: URL scripted against the time the driver has asked to wait, and the document goto
 * returns. Optionally a later main-frame document, handed to the page's response listeners once
 * the driver has waited long enough - the reload a challenge does when it clears.
 */
function fakePage(opts: {
  url: (waited: number) => string;
  headers?: Record<string, string>;
  status?: number;
  markers?: number;
  /** goto rejects with this instead of returning the document. */
  gotoError?: Error;
  later?: { after: number; headers?: Record<string, string>; status?: number };
}) {
  const mainFrame = {};
  const doc = (status: number, headers: Record<string, string>) => ({
    status: () => status,
    headers: () => headers,
    request: () => ({ isNavigationRequest: () => true }),
    frame: () => mainFrame,
  });
  const listeners = new Set<(r: unknown) => void>();
  const deliver = (r: unknown) => {
    for (const fn of listeners) fn(r);
  };
  let waited = 0;
  let delivered = false;
  const locator = { first: () => locator, count: async () => opts.markers ?? 0 };
  const page = {
    goto: async () => {
      if (opts.gotoError) throw opts.gotoError;
      const first = doc(opts.status ?? 200, opts.headers ?? {});
      deliver(first);
      return first;
    },
    url: () => opts.url(waited),
    on: (event: string, fn: (r: unknown) => void) => {
      if (event === "response") listeners.add(fn);
    },
    off: (event: string, fn: (r: unknown) => void) => {
      if (event === "response") listeners.delete(fn);
    },
    mainFrame: () => mainFrame,
    waitForTimeout: async (ms: number) => {
      waited += ms;
      if (opts.later && !delivered && waited >= opts.later.after) {
        delivered = true;
        deliver(doc(opts.later.status ?? 200, opts.later.headers ?? {}));
      }
    },
    locator: () => locator,
    evaluate: async () => false,
  };
  return {
    session: { context: { pages: () => [page] } } as unknown as SessionHandle,
    waited: () => waited,
    listening: () => listeners.size,
  };
}

// Real-clock budgets, kept tiny: the fake page never really waits.
const FAST = { bounceMs: 40, challengeMs: 40, pollMs: 5 };

describe("PlaywrightEpicDriver.checkSignIn", () => {
  it("reads Cloudflare's cf-mitigated header as a challenge, and reports blocked when it stays", async () => {
    const page = fakePage({ url: () => ACCOUNT, status: 403, headers: { "cf-mitigated": "challenge" } });
    expect(await new PlaywrightEpicDriver(page.session, FAST).checkSignIn()).toEqual({
      state: "blocked",
      path: "/account/personal",
      status: 403,
      bounced: false,
    });
    expect(page.listening()).toBe(0);
  });

  it("a header challenge clears once a later document comes without it", async () => {
    // A managed challenge solves itself and reloads the page. The reload is now the latest
    // document, and it no longer carries cf-mitigated.
    const page = fakePage({
      url: () => ACCOUNT,
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      later: { after: 15, status: 200 },
    });
    const driver = new PlaywrightEpicDriver(page.session, { ...FAST, challengeMs: 5_000 });
    expect(await driver.checkSignIn()).toEqual({
      state: "signed_in",
      path: "/account/personal",
      status: 200,
      bounced: false,
    });
    expect(page.waited()).toBeGreaterThanOrEqual(15);
    // The listener goes with the check, so a later check does not read this one's documents.
    expect(page.listening()).toBe(0);
  });

  it("does not read the __cf_chl_ tokens a solved challenge leaves in the URL as a challenge", async () => {
    // `/account/personal?__cf_chl_f_tk=...` is the real account page, after the challenge.
    const page = fakePage({ url: () => `${ACCOUNT}?__cf_chl_f_tk=x` });
    expect(await new PlaywrightEpicDriver(page.session, FAST).checkSignIn()).toEqual({
      state: "signed_in",
      path: "/account/personal",
      status: 200,
      bounced: false,
    });
    expect(page.waited()).toBe(0);
  });

  it("recognises a challenge by its page markup when the header is absent", async () => {
    const page = fakePage({ url: () => ACCOUNT, markers: 1 });
    expect((await new PlaywrightEpicDriver(page.session, FAST).checkSignIn()).state).toBe("blocked");
  });

  it("waits out the login page's bounce", async () => {
    const page = fakePage({ url: (waited) => (waited < 15 ? LOGIN : ACCOUNT) });
    const driver = new PlaywrightEpicDriver(page.session, { ...FAST, bounceMs: 5_000 });
    expect(await driver.checkSignIn()).toMatchObject({ state: "signed_in", bounced: true });
  });

  it("a goto interrupted by the bounce is judged on where the page is, not thrown", async () => {
    // The login page sending the browser back before its own document finished loading.
    const page = fakePage({
      url: () => ACCOUNT,
      gotoError: new Error(
        `page.goto: Navigation to "${ACCOUNT}" is interrupted by another navigation to "${ACCOUNT}"`,
      ),
    });
    expect(await new PlaywrightEpicDriver(page.session, FAST).checkSignIn()).toEqual({
      state: "signed_in",
      path: "/account/personal",
      bounced: false,
    });
  });

  it("any other navigation failure still throws", async () => {
    const page = fakePage({
      url: () => "about:blank",
      gotoError: new Error("page.goto: net::ERR_NAME_NOT_RESOLVED"),
    });
    await expect(new PlaywrightEpicDriver(page.session, FAST).checkSignIn()).rejects.toThrow(
      /ERR_NAME_NOT_RESOLVED/,
    );
    expect(page.listening()).toBe(0);
  });

  it("is signed out when the login page stays", async () => {
    const page = fakePage({ url: () => LOGIN });
    expect(await new PlaywrightEpicDriver(page.session, FAST).checkSignIn()).toMatchObject({
      state: "signed_out",
      path: "/id/login",
    });
  });
});
