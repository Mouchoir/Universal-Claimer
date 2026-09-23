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
  PlaywrightPrimeGamingDriver,
  isLunaHost,
  platformFromOfferUrl,
  type AuthReport,
  type PrimeGamingDriverFactory,
  type PrimeGamingPageDriver,
  type PrimeOffer,
  type SignInAttempt,
} from "./driver.js";

const PRIME_GAMING_URL = "https://gaming.amazon.com";
const PRIME_CAPTCHA_KEY = "prime-gaming-key-placeholder";

const REEXPORT = "in your browser, then re-export the session and reconnect.";

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "gaming.amazon.com (served luna.amazon.com), luna.amazon.co.jp (unreachable)". */
function describeAttempts(attempts: SignInAttempt[]): string {
  return attempts
    .map((a) => {
      if (a.navError) return `${a.requested} (unreachable)`;
      return a.served && a.served !== a.requested ? `${a.requested} (served ${a.served})` : a.requested;
    })
    .join(", ");
}

/**
 * The reauth_needed message, built from what the sign-in check actually saw.
 *
 * Amazon signs you in per marketplace and Luna serves each marketplace on its own host, so
 * "sign in again" only helps when it names the operator's own Luna host. Naming whatever host
 * happened to be served sent accounts signed in only on amazon.fr to sign in on
 * luna.amazon.com, a page that can never see their sign-in. So the advice only ever names the
 * Luna host of a marketplace the session is signed in on, and says what each one showed.
 */
export function reauthSummary(report: AuthReport): string {
  const tried = report.attempts.length ? ` Tried: ${describeAttempts(report.attempts)}.` : "";
  if (report.marketplaces.length === 0) {
    return (
      "No Amazon sign-in found in the session: it holds no unexpired Amazon auth cookie on any " +
      "marketplace. Sign in on your own marketplace's Luna page (luna.amazon.fr for amazon.fr, " +
      `luna.amazon.com for amazon.com, and so on) ${REEXPORT}${tried}`
    );
  }

  const findings: string[] = [];
  const refused: string[] = [];
  for (const marketplace of report.marketplaces) {
    const host = `luna.${marketplace}`;
    const served = report.attempts.find((a) => a.served === host);
    const asked = report.attempts.find((a) => a.requested === host);
    if (served) {
      findings.push(`${host} showed the account signed out`);
      refused.push(host);
    } else if (asked?.navError) {
      findings.push(`${host} could not be reached`);
    } else if (asked) {
      findings.push(
        `${host} redirected to ${asked.served || "another page"}, which showed the account signed out`,
      );
      refused.push(host);
    } else {
      findings.push(`${host} was not checked`);
      refused.push(host);
    }
  }

  // gaming.amazon.com reads the .com identity and sends it to the account's own Luna host. When
  // that host belongs to a marketplace the session is not signed in on, Amazon has just said
  // where the account lives, and that is the page to sign in on rather than luna.amazon.com.
  const entry = report.attempts[0];
  const routedHome =
    report.marketplaces.includes("amazon.com") &&
    entry &&
    isLunaHost(entry.served) &&
    !report.marketplaces.some((m) => `luna.${m}` === entry.served)
      ? entry.served
      : undefined;

  let advice: string;
  if (routedHome) {
    advice =
      ` Amazon routes this account to ${routedHome}, so that is its own marketplace's Luna page: ` +
      `sign in on ${routedHome} ${REEXPORT}`;
  } else if (refused.length) {
    advice = ` The sign-in there has expired or Amazon rejected it: sign in again on ${listOf(refused)} ${REEXPORT}`;
  } else {
    advice =
      " No Luna page could be reached for the marketplaces this session is signed in on, so it has " +
      "nowhere to claim from.";
  }
  return `Signed in on ${listOf(report.marketplaces)}, but ${listOf(findings)}.${advice}${tried}`;
}

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
        const ok = await this.checkSignIn(driver, ctx);
        return {
          ok,
          fingerprint,
          reason: ok ? undefined : reauthSummary(await driver.authReport()),
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

      if (!(await this.checkSignIn(driver, ctx))) {
        // Amazon signs you in per marketplace, so a session that is perfectly valid on one
        // Amazon domain is signed out on another. Saying which marketplaces the session holds
        // and what each Luna host showed turns a dead end into an actionable message.
        return { outcome: "reauth_needed", summary: reauthSummary(await driver.authReport()) };
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

      const claimed: PrimeOffer[] = [];
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
        if (res.claimed) claimed.push(offer);
        else if (!res.alreadyOwned) failed.push(offer.title);
      }

      if (claimed.length > 0) {
        const suffix = failed.length ? `; could not complete: ${failed.join(", ")}` : "";
        const titles = claimed.map((o) => o.title);
        return {
          outcome: "claimed",
          summary: `Claimed: ${titles.join(", ")}${suffix}`,
          // Record where each game has to be redeemed and by when: several Prime Gaming titles
          // arrive as store keys that stop working once the offer ends.
          claimedItems: claimed.map((o) => ({
            kind: "game" as const,
            title: o.title,
            ...(platformFromOfferUrl(o.url) ? { platform: platformFromOfferUrl(o.url) } : {}),
          })),
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

  /**
   * Run the sign-in check and log where it looked. The log carries marketplace and host names
   * only, never a cookie: which Luna host accepted or refused the session is exactly what is
   * needed to tell a lapsed sign-in from a wrong-marketplace one after the fact.
   */
  private async checkSignIn(driver: PrimeGamingPageDriver, ctx: ConnectorContext): Promise<boolean> {
    const signedIn = await driver.isAuthenticated();
    const report = await driver.authReport();
    ctx.log.info("prime gaming sign-in check", {
      signedIn,
      marketplaces: report.marketplaces,
      attempts: report.attempts,
    });
    return signedIn;
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
export type {
  AuthReport,
  PrimeGamingPageDriver,
  PrimeGamingDriverFactory,
  PrimeOffer,
  SignInAttempt,
} from "./driver.js";
