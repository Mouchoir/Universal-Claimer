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
import { PlaywrightMsRewardsDriver, type MsRewardsDriverFactory } from "./driver.js";
import { pickQuery } from "./queries.js";

const MS_CAPTCHA_URL = "https://rewards.bing.com";
const MS_CAPTCHA_KEY = "ms-key-placeholder";
const DEFAULT_MAX_SEARCHES = 30;

export interface MsRewardsDeps {
  createDriver?: MsRewardsDriverFactory;
  /** Humanized inter-search delay. Injectable (no-op in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for query choice + delay jitter. Injectable (deterministic in tests). */
  rand?: () => number;
  maxSearches?: number;
}

/**
 * Microsoft Rewards connector: a claim runs today's outstanding desktop searches with
 * humanized delays and varied queries. Orchestration is unit-tested via a fake driver +
 * injected sleep/rand.
 */
export class MsRewardsConnector implements Connector, InteractiveLogin {
  readonly id = "microsoft";
  readonly version = "0.1.0";
  readonly methods: ConnectionMethod[] = ["session_import", "credential_totp"];
  readonly loginUrl = "https://login.live.com/";
  readonly configFields = []; // no per-account config

  private readonly createDriver: MsRewardsDriverFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  private readonly maxSearches: number;

  constructor(deps: MsRewardsDeps = {}) {
    this.createDriver = deps.createDriver ?? ((s) => new PlaywrightMsRewardsDriver(s));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rand = deps.rand ?? Math.random;
    this.maxSearches = deps.maxSearches ?? DEFAULT_MAX_SEARCHES;
  }

  async authenticate(input: AuthInput, ctx: ConnectorContext): Promise<AuthResult> {
    const fingerprint = defaultFingerprint();
    const session = await ctx.browser.launch(fingerprint);
    try {
      const driver = this.createDriver(session);
      if (input.method === "session_import") {
        await driver.applyCookies(input.cookies);
        const ok = await driver.isAuthenticated();
        return { ok, fingerprint, reason: ok ? undefined : "Microsoft session is not authenticated" };
      }
      const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
      const res = await driver.loginWithPassword(input.email, input.password, totp);
      if (res.captcha) return { ok: false, fingerprint, reason: "captcha during login; use session import" };
      return { ok: res.authenticated, fingerprint, reason: res.authenticated ? undefined : "login failed" };
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
      if (input.method === "session_import") await driver.applyCookies(input.cookies);
      else {
        const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
        await driver.loginWithPassword(input.email, input.password, totp);
      }

      if (!(await driver.isAuthenticated())) {
        return { outcome: "reauth_needed", summary: "Microsoft session expired; reconnect the account." };
      }

      const remaining = await driver.remainingSearches();
      const target = Math.min(Math.max(0, remaining), this.maxSearches);
      if (target === 0) {
        return { outcome: "nothing_to_claim", summary: "Today's Rewards searches are already done." };
      }

      let done = 0;
      for (let i = 0; i < target; i++) {
        const res = await driver.search(pickQuery(this.rand));
        if (res.captcha) {
          const token = await ctx.captcha.solve({
            type: "recaptcha_v2",
            websiteURL: MS_CAPTCHA_URL,
            websiteKey: MS_CAPTCHA_KEY,
          });
          if (!token) {
            ctx.emit({
              type: "requires_human_action",
              prompt: "Microsoft Rewards showed a verification. Solve it, then resume.",
            });
            // Return progress made so far as a success if any, else defer to human action.
            return done > 0
              ? { outcome: "claimed", summary: `Completed ${done} searches before a verification.` }
              : { outcome: "requires_human_action", summary: "Verification required before searches." };
          }
        }
        if (res.ok) done += 1;
        // Humanized delay: ~1.5–4.5s between searches.
        await this.sleep(1500 + Math.floor(this.rand() * 3000));
      }

      if (done === 0) {
        return { outcome: "failed", summary: "Could not complete any Rewards search." };
      }
      return { outcome: "claimed", summary: `Completed ${done} Rewards searches.` };
    } finally {
      await ctx.browser.close(session);
    }
  }

  async healthCheck(_ctx: ConnectorContext): Promise<HealthResult> {
    return { healthy: true };
  }

  async isLoggedIn(session: SessionHandle, _ctx: ConnectorContext): Promise<boolean> {
    return this.createDriver(session).isAuthenticated();
  }

  async extractCookies(session: SessionHandle): Promise<BrowserCookie[]> {
    return this.createDriver(session).getCookies();
  }
}

export { PlaywrightMsRewardsDriver } from "./driver.js";
export type { MsRewardsPageDriver, MsRewardsDriverFactory } from "./driver.js";
