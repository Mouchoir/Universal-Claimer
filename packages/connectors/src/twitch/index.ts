import { defaultFingerprint } from "../fingerprint.js";
import type {
  AuthInput,
  AuthResult,
  BrowserCookie,
  ClaimResult,
  ConfigField,
  ConnectionMethod,
  Connector,
  ConnectorConfig,
  ConnectorContext,
  Fingerprint,
  HealthResult,
  InteractiveLogin,
  SessionHandle,
} from "../connector.js";
import { PlaywrightTwitchDriver, type TwitchDriverFactory } from "./driver.js";

const TWITCH_RECAPTCHA_URL = "https://www.twitch.tv";
const TWITCH_RECAPTCHA_KEY = "twitch-key-placeholder";

/**
 * Twitch Prime resub connector (reference implementation of a targeted, config-driven
 * action). Orchestration is unit-tested via an injected fake driver.
 */
export class TwitchConnector implements Connector, InteractiveLogin {
  readonly id = "twitch";
  readonly version = "0.1.0";
  readonly methods: ConnectionMethod[] = ["session_import", "credential_totp"];
  readonly loginUrl = "https://www.twitch.tv/login";
  readonly configFields: ConfigField[] = [
    {
      key: "channel",
      // Explicitly the *streamer* being subscribed to, not the operator's own account — the
      // previous wording plus an example username read as "enter your account name".
      label: "Streamer channel to spend your Prime sub on",
      required: true,
      placeholder: "twitch.tv/<channel>",
      help:
        "The channel you want to support with your free monthly Prime subscription — not your own " +
        "account. Your account is whichever one you connected above.",
    },
  ];

  private readonly createDriver: TwitchDriverFactory;

  constructor(deps: { createDriver?: TwitchDriverFactory } = {}) {
    this.createDriver = deps.createDriver ?? ((session) => new PlaywrightTwitchDriver(session));
  }

  async authenticate(input: AuthInput, ctx: ConnectorContext): Promise<AuthResult> {
    const fingerprint = defaultFingerprint();
    const session = await ctx.browser.launch(fingerprint);
    try {
      const driver = this.createDriver(session);
      if (input.method === "session_import") {
        await driver.applyCookies(input.cookies);
        const ok = await driver.isAuthenticated();
        return { ok, fingerprint, reason: ok ? undefined : "Twitch session is not authenticated" };
      }
      const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
      const res = await driver.loginWithPassword(input.email, input.password, totp);
      if (res.captcha) {
        return { ok: false, fingerprint, reason: "captcha during login; use session import" };
      }
      return { ok: res.authenticated, fingerprint, reason: res.authenticated ? undefined : "login failed" };
    } finally {
      await ctx.browser.close(session);
    }
  }

  async claim(
    input: AuthInput,
    fingerprint: Fingerprint,
    config: ConnectorConfig,
    ctx: ConnectorContext,
  ): Promise<ClaimResult> {
    const channel = (config.channel ?? "").trim();
    if (!channel) {
      return { outcome: "failed", summary: "No Twitch channel configured for this account." };
    }

    const session = await ctx.browser.launch(fingerprint);
    try {
      const driver = this.createDriver(session);
      if (input.method === "session_import") await driver.applyCookies(input.cookies);
      else {
        const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
        await driver.loginWithPassword(input.email, input.password, totp);
      }

      if (!(await driver.isAuthenticated())) {
        return { outcome: "reauth_needed", summary: "Twitch session expired; reconnect the account." };
      }

      let res = await driver.resubWithPrime(channel);
      if (res.captcha) {
        const token = await ctx.captcha.solve({
          type: "recaptcha_v2",
          websiteURL: TWITCH_RECAPTCHA_URL,
          websiteKey: TWITCH_RECAPTCHA_KEY,
        });
        if (token) res = await driver.resubWithPrime(channel);
        if (res.captcha) {
          ctx.emit({
            type: "requires_human_action",
            prompt: `A captcha must be solved to resubscribe to "${channel}". Solve it, then resume.`,
          });
          return { outcome: "requires_human_action", summary: `Captcha needed for "${channel}".` };
        }
      }
      if (res.notFound) {
        return { outcome: "failed", summary: `Twitch channel "${channel}" was not found.` };
      }
      if (res.alreadyActive) {
        return { outcome: "nothing_to_claim", summary: `Prime sub to "${channel}" is already active.` };
      }
      if (res.subscribed) {
        return { outcome: "claimed", summary: `Resubscribed to "${channel}" with Prime.` };
      }
      return { outcome: "nothing_to_claim", summary: `Nothing to do for "${channel}".` };
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

export { PlaywrightTwitchDriver } from "./driver.js";
export type { TwitchPageDriver, TwitchDriverFactory } from "./driver.js";
