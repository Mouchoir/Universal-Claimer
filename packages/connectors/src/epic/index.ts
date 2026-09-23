import { defaultFingerprint } from "../fingerprint.js";
import type {
  AuthInput,
  AuthResult,
  BrowserCookie,
  ClaimResult,
  ConnectionMethod,
  Connector,
  ConnectorConfig,
  ConnectorContext,
  Fingerprint,
  HealthResult,
  InteractiveLogin,
  SessionHandle,
} from "../connector.js";
import {
  PlaywrightEpicDriver,
  type EpicDriverFactory,
  type EpicPageDriver,
  type EpicSignInCheck,
} from "./driver.js";

// Epic's store captcha site key (recaptcha). Placeholder — validate against the live page.
const EPIC_RECAPTCHA_KEY = "6Lc5-key-placeholder";
const EPIC_STORE_URL = "https://store.epicgames.com";

/**
 * Epic's auth cookies, named in a signed-out summary so it says which part of the session is
 * gone: the short-lived tokens (EPIC_BEARER_TOKEN, EPIC_SSO) or the longer-lived cookies that
 * let the login page renew them. Diagnostics only - nothing is decided on them, because Epic
 * renames and reshuffles these without notice and the account page is the only real verdict.
 */
const EPIC_AUTH_COOKIES = [
  "EPIC_SSO",
  "EPIC_BEARER_TOKEN",
  "EPIC_SESSION_AP",
  "EPIC_SSO_RM",
  "EPIC_DEVICE",
] as const;

type CookieExpiry = "valid" | "session" | "expired";

/** Playwright reports a session cookie's expiry as -1 (and a hand-made cookie may have none). */
function cookieExpiry(cookie: BrowserCookie, now: number): CookieExpiry {
  if (cookie.expires === undefined || cookie.expires === -1) return "session";
  return cookie.expires * 1000 > now ? "valid" : "expired";
}

const EXPIRY_RANK: Record<CookieExpiry, number> = { valid: 2, session: 1, expired: 0 };

/**
 * Which of Epic's auth cookies the browser holds, and whether each is still good - names and
 * states only. A value never enters this string: it ends up in the run history and in the
 * outbound notification.
 */
export function describeAuthCookies(cookies: BrowserCookie[], now: number): string {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of EPIC_AUTH_COOKIES) {
    // The same name can be set on several Epic hosts; the best of them is what the site sees.
    const states = cookies.filter((c) => c.name === name).map((c) => cookieExpiry(c, now));
    if (states.length === 0) missing.push(name);
    else {
      const best = states.reduce((a, b) => (EXPIRY_RANK[b] > EXPIRY_RANK[a] ? b : a));
      present.push(`${name} (${best})`);
    }
  }
  return `Auth cookies present: ${present.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`;
}

/** The summary for a check that ended on a Cloudflare challenge. */
function blockedSummary(check: EpicSignInCheck): string {
  return `Blocked by a Cloudflare challenge at ${check.path}.`;
}

/**
 * Where a signed-out check stopped, and what the browser still held. "Session expired" on its
 * own left the operator reconnecting blind; the path and the cookie states say whether the login
 * page was reached at all and which cookies Epic had already dropped.
 */
async function signedOutDetail(driver: EpicPageDriver, check: EpicSignInCheck): Promise<string> {
  const where = `it stopped at ${check.path} after giving Epic's login page time to renew it.`;
  // Names are read from the cookies here and nowhere else; the values are never kept.
  const cookies = await driver.getCookies().catch(() => undefined);
  return cookies ? `${where} ${describeAuthCookies(cookies, Date.now())}` : where;
}

/**
 * Why a check that did not end signed in failed. `lead` says what was being attempted; a
 * challenge gets the blocked summary whatever it was, since neither the cookies nor the
 * credentials are what needs fixing then.
 */
async function notSignedInReason(
  driver: EpicPageDriver,
  check: EpicSignInCheck,
  lead: string,
): Promise<string> {
  if (check.state === "blocked") return blockedSummary(check);
  return `${lead}: ${await signedOutDetail(driver, check)}`;
}

/**
 * Epic Games connector (reference implementation). Orchestration logic here is unit-tested
 * via an injected fake driver; the Playwright DOM specifics live in {@link PlaywrightEpicDriver}.
 */
export class EpicConnector implements Connector, InteractiveLogin {
  readonly id = "epic";
  readonly version = "0.1.0";
  readonly methods: ConnectionMethod[] = ["session_import", "credential_totp"];
  readonly loginUrl = "https://www.epicgames.com/id/login";

  private readonly createDriver: EpicDriverFactory;

  constructor(deps: { createDriver?: EpicDriverFactory } = {}) {
    this.createDriver = deps.createDriver ?? ((session) => new PlaywrightEpicDriver(session));
  }

  async authenticate(input: AuthInput, ctx: ConnectorContext): Promise<AuthResult> {
    const fingerprint = defaultFingerprint();
    const session = await ctx.browser.launch(fingerprint);
    try {
      const driver = this.createDriver(session);
      if (input.method === "session_import") {
        await driver.applyCookies(input.cookies);
        const check = await driver.checkSignIn();
        if (check.state === "signed_in") return { ok: true, fingerprint };
        return {
          ok: false,
          fingerprint,
          reason: await notSignedInReason(
            driver,
            check,
            "session is not authenticated (expired or invalid cookies)",
          ),
        };
      }
      const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
      const res = await driver.loginWithPassword(input.email, input.password, totp);
      if (res.captcha) {
        return {
          ok: false,
          fingerprint,
          reason: "a captcha was required during login; solve it and use session import instead",
        };
      }
      if (res.check.state === "signed_in") return { ok: true, fingerprint };
      return {
        ok: false,
        fingerprint,
        reason: await notSignedInReason(driver, res.check, "login failed (check credentials / TOTP)"),
      };
    } finally {
      await ctx.browser.close(session);
    }
  }

  async claim(
    input: AuthInput,
    fingerprint: Fingerprint,
    _config: ConnectorConfig,
    ctx: ConnectorContext,
  ): Promise<ClaimResult> {
    const session = await ctx.browser.launch(fingerprint);
    const driver = this.createDriver(session);
    let authenticated = false;
    try {
      // Re-establish authentication within this session from the stored secret. A password login
      // already ends on the sign-in check; running it again would reopen the account page for
      // nothing, with another bounce and challenge wait on top.
      let check: EpicSignInCheck;
      if (input.method === "session_import") {
        await driver.applyCookies(input.cookies);
        check = await driver.checkSignIn();
      } else {
        const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
        const res = await driver.loginWithPassword(input.email, input.password, totp);
        if (res.captcha) {
          // The same way out authenticate() gives: the password route is stuck behind the
          // captcha, and a session import does not go through the login form at all.
          return {
            outcome: "reauth_needed",
            summary:
              "Epic asked for a captcha during login; solve it and reconnect the account with a session import.",
          };
        }
        check = res.check;
      }

      // Neutral keys only: the logger hides anything that looks like a session or a cookie.
      ctx.log.info("epic sign-in check", {
        state: check.state,
        path: check.path,
        status: check.status,
        bounced: check.bounced,
      });
      if (check.state === "blocked") {
        // Not reauth_needed: a challenge says nothing about the session, and reconnecting would
        // only swap a good session for the same one.
        return { outcome: "failed", summary: blockedSummary(check) };
      }
      if (check.state === "signed_out") {
        return {
          outcome: "reauth_needed",
          summary: `Epic session is no longer authenticated: ${await signedOutDetail(driver, check)} Reconnect the account.`,
        };
      }
      // Signed in, including through a bounce: the login page just renewed the short-lived
      // tokens, which makes this exactly the run whose cookies must be persisted below.
      authenticated = true;

      // Read the account name as soon as we know the session is good, so the dashboard learns it
      // even on the (common) weeks where there is nothing to claim.
      const accountFacts = { username: await driver.getUsername() };

      const games = await driver.listClaimableGames();
      if (games.length === 0) {
        return {
          outcome: "nothing_to_claim",
          summary: "No free game available to claim right now.",
          accountFacts,
        };
      }

      const claimed: string[] = [];
      const failed: string[] = [];
      for (const game of games) {
        let res = await driver.claimGame(game);
        if (res.captcha) {
          const token = await ctx.captcha.solve({
            type: "recaptcha_v2",
            websiteURL: EPIC_STORE_URL,
            websiteKey: EPIC_RECAPTCHA_KEY,
          });
          if (token) res = await driver.claimGame(game, token);
          if (res.captcha) {
            ctx.emit({
              type: "requires_human_action",
              prompt: `A captcha must be solved to claim "${game.title}". Solve it, then resume.`,
            });
            return {
              outcome: "requires_human_action",
              summary: `A captcha for "${game.title}" could not be solved automatically — human action needed.`,
            };
          }
        }
        if (res.claimed) claimed.push(game.title);
        else if (!res.alreadyOwned) {
          // Record what the store showed, and what kind of offer this was. A promotion can be an
          // ADD_ON or a BUNDLE rather than a game, and those do not check out like one — without
          // saying so, every such failure looks like the same unexplained checkout bug and
          // repeats daily with nothing new to go on.
          const detail = [res.reason, game.kind && game.kind !== "BASE_GAME" ? game.kind : null]
            .filter(Boolean)
            .join(", ");
          failed.push(detail ? `${game.title} (${detail})` : game.title);
        }
      }

      if (claimed.length > 0) {
        const suffix = failed.length ? `; could not complete: ${failed.join(", ")}` : "";
        return {
          outcome: "claimed",
          summary: `Claimed: ${claimed.join(", ")}${suffix}`,
          claimedItems: claimed.map((title) => ({ kind: "game" as const, title })),
          accountFacts,
        };
      }
      if (failed.length > 0) {
        return {
          outcome: "failed",
          summary: `Found free game(s) but could not complete checkout for: ${failed.join(", ")}.`,
          accountFacts,
        };
      }
      return {
        outcome: "nothing_to_claim",
        summary: `Nothing new to claim (${games.length} free game(s) already owned).`,
        accountFacts,
      };
    } finally {
      // Epic renewed its short-lived auth tokens during this run (they last hours, and the login
      // page's bounce is one of the places it renews them); hand them back so the stored copy
      // stays current instead of lapsing between runs (see ConnectorContext).
      if (authenticated && input.method === "session_import" && ctx.persistRefreshedSession) {
        await ctx
          .persistRefreshedSession(await driver.getCookies())
          .catch(() => undefined); // refreshing is best-effort; never fail a completed claim
      }
      await ctx.browser.close(session);
    }
  }

  async healthCheck(_ctx: ConnectorContext): Promise<HealthResult> {
    // Structural check only; a deeper check would confirm the store page shape.
    return { healthy: true };
  }

  // --- InteractiveLogin (assisted login) ---

  async isLoggedIn(session: SessionHandle, _ctx: ConnectorContext): Promise<boolean> {
    return (await this.createDriver(session).checkSignIn()).state === "signed_in";
  }

  async extractCookies(session: SessionHandle): Promise<BrowserCookie[]> {
    return this.createDriver(session).getCookies();
  }
}

export { PlaywrightEpicDriver } from "./driver.js";
export type {
  EpicPageDriver,
  EpicDriverFactory,
  EpicLoginResult,
  EpicSignInCheck,
  EpicSignInState,
} from "./driver.js";
