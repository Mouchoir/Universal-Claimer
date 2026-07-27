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
import { PlaywrightEpicDriver, type EpicDriverFactory } from "./driver.js";

// Epic's store captcha site key (recaptcha). Placeholder — validate against the live page.
const EPIC_RECAPTCHA_KEY = "6Lc5-key-placeholder";
const EPIC_STORE_URL = "https://store.epicgames.com";

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
        const ok = await driver.isAuthenticated();
        return {
          ok,
          fingerprint,
          reason: ok ? undefined : "session is not authenticated (expired or invalid cookies)",
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
      return {
        ok: res.authenticated,
        fingerprint,
        reason: res.authenticated ? undefined : "login failed (check credentials / TOTP)",
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
    try {
      const driver = this.createDriver(session);

      // Re-establish authentication within this session from the stored secret.
      if (input.method === "session_import") {
        await driver.applyCookies(input.cookies);
      } else {
        const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
        await driver.loginWithPassword(input.email, input.password, totp);
      }

      if (!(await driver.isAuthenticated())) {
        return {
          outcome: "reauth_needed",
          summary: "Epic session is no longer authenticated; reconnect the account.",
        };
      }

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
        else if (!res.alreadyOwned) failed.push(game.title); // neither claimed nor already owned
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
      await ctx.browser.close(session);
    }
  }

  async healthCheck(_ctx: ConnectorContext): Promise<HealthResult> {
    // Structural check only; a deeper check would confirm the store page shape.
    return { healthy: true };
  }

  // --- InteractiveLogin (assisted login) ---

  async isLoggedIn(session: SessionHandle, _ctx: ConnectorContext): Promise<boolean> {
    return this.createDriver(session).isAuthenticated();
  }

  async extractCookies(session: SessionHandle): Promise<BrowserCookie[]> {
    return this.createDriver(session).getCookies();
  }
}

export { PlaywrightEpicDriver } from "./driver.js";
export type { EpicPageDriver, EpicDriverFactory } from "./driver.js";
