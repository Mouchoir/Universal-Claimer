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
import { PlaywrightPrimeGamingDriver, type PrimeGamingDriverFactory } from "./driver.js";

const PRIME_GAMING_URL = "https://gaming.amazon.com";
const PRIME_CAPTCHA_KEY = "prime-gaming-key-placeholder";

/**
 * Amazon Prime Gaming connector: claims the free games included with Prime. Orchestration is
 * unit-tested via an injected fake driver; the page specifics live in the Playwright driver.
 */
export class PrimeGamingConnector implements Connector, InteractiveLogin {
  readonly id = "primegaming";
  readonly version = "0.1.0";
  readonly methods: ConnectionMethod[] = ["session_import", "credential_totp"];
  readonly loginUrl = "https://gaming.amazon.com/home";
  // New free games appear on a rolling basis, so a recurring check is the right cadence.
  readonly schedulingMode = "recurring" as const;

  private readonly createDriver: PrimeGamingDriverFactory;

  constructor(deps: { createDriver?: PrimeGamingDriverFactory } = {}) {
    this.createDriver = deps.createDriver ?? ((session) => new PlaywrightPrimeGamingDriver(session));
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
          reason: ok ? undefined : "Amazon session is not authenticated (expired or invalid cookies)",
        };
      }
      // Amazon's password flow is heavily challenged (OTP, device verification); session import
      // is the supported path and the connect page recommends it.
      return {
        ok: false,
        fingerprint,
        reason: "Amazon sign-in must be done in your own browser; use session import.",
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
      if (input.method === "session_import") await driver.applyCookies(input.cookies);

      if (!(await driver.isAuthenticated())) {
        return {
          outcome: "reauth_needed",
          summary: "Amazon session is no longer authenticated; reconnect the account.",
        };
      }
      authenticated = true;

      // Read the account name while the session is open — free, and the dashboard shows it.
      const accountFacts = { username: await driver.getUsername() };

      const offers = await driver.listClaimableGames();
      if (offers.length === 0) {
        return {
          outcome: "nothing_to_claim",
          summary: "No Prime Gaming offer available to claim right now.",
          accountFacts,
        };
      }

      const claimed: string[] = [];
      const failed: string[] = [];
      for (const offer of offers) {
        const res = await driver.claimGame(offer);
        if (res.captcha) {
          const token = await ctx.captcha.solve({
            type: "recaptcha_v2",
            websiteURL: PRIME_GAMING_URL,
            websiteKey: PRIME_CAPTCHA_KEY,
          });
          if (!token) {
            ctx.emit({
              type: "requires_human_action",
              prompt: `A challenge must be solved to claim "${offer.title}". Solve it, then resume.`,
            });
            return {
              outcome: "requires_human_action",
              summary: `A challenge for "${offer.title}" could not be solved automatically.`,
              accountFacts,
            };
          }
        }
        if (res.claimed) claimed.push(offer.title);
        else if (!res.alreadyOwned) failed.push(offer.title);
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
          summary: `Found offer(s) but could not complete the claim for: ${failed.join(", ")}.`,
          accountFacts,
        };
      }
      return {
        outcome: "nothing_to_claim",
        summary: `Nothing new to claim (${offers.length} offer(s) already in your library).`,
        accountFacts,
      };
    } finally {
      // Hand back the tokens the service refreshed during this run so the stored session does
      // not silently expire (see ConnectorContext.persistRefreshedSession).
      if (authenticated && input.method === "session_import" && ctx.persistRefreshedSession) {
        await ctx.persistRefreshedSession(await driver.getCookies()).catch(() => undefined);
      }
      await ctx.browser.close(session);
    }
  }

  async healthCheck(_ctx: ConnectorContext): Promise<HealthResult> {
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

export { PlaywrightPrimeGamingDriver } from "./driver.js";
export type { PrimeGamingPageDriver, PrimeGamingDriverFactory, PrimeOffer } from "./driver.js";
