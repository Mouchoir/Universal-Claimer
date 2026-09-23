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
import type { Logger } from "@uc/core";
import {
  PlaywrightTwitchDriver,
  type ResubResult,
  type SubEvidence,
  type SubKind,
  type TwitchDriverFactory,
} from "./driver.js";

const TWITCH_RECAPTCHA_URL = "https://www.twitch.tv";
const TWITCH_RECAPTCHA_KEY = "twitch-key-placeholder";

const KIND_LABEL: Record<SubKind, string> = {
  prime: "Prime sub",
  gift: "Gifted sub",
  paid: "Paid sub",
  unknown: "A sub",
};

/** The calendar day of an ISO date, in UTC: the same string whatever the operator's locale. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The summary of an "already active" verdict, worded from how it was reached.
 *
 * It used to say "Prime sub to X is already active" whatever the sub was and whoever said so.
 * The two are not equally trustworthy: Twitch's API states the sub and its end date, while the
 * page only shows a button, and the page is also what gets read when the API could not be asked.
 * A run that skipped the renewal has to say which of those it rested on, or the day it is wrong
 * nobody can tell from the history.
 */
export function activeSubSummary(channel: string, evidence: SubEvidence | undefined): string {
  if (!evidence) return `A sub to "${channel}" is already active.`;
  const fromApi = evidence.decidedBy === "api";
  // The API reports Prime explicitly, so from there an unknown kind is at least not Prime.
  const what =
    fromApi && evidence.kind === "unknown" ? "A non-Prime sub" : KIND_LABEL[evidence.kind];
  const when = evidence.endsAt
    ? ` until ${day(evidence.endsAt)}`
    : evidence.renewsAt
      ? `, renewing on ${day(evidence.renewsAt)}`
      : fromApi
        ? " with no end date"
        : "";
  const why = evidence.apiUnavailable ?? "no reason was given";
  const source = fromApi
    ? "from Twitch's API"
    : `from the channel page; Twitch's API could not be asked: ${why}`;
  return `${what} to "${channel}" is active${when} (${source}).`;
}

/**
 * The run's one line on how the resub decision was reached. Key names are deliberately neutral:
 * the logger redacts anything that looks like a secret by key, and none of these is one.
 */
function logVerdict(log: Logger, res: ResubResult): void {
  const ev = res.evidence;
  log.info("twitch sub verdict", {
    decidedBy: ev?.decidedBy ?? "none",
    apiHttpStatus: ev?.apiHttpStatus,
    apiErrors: ev?.apiFirstError,
    apiUnavailable: ev?.apiUnavailable,
    listCount: ev?.listCount,
    listHasChannel: ev?.listHasChannel,
    kind: ev?.kind,
    endsAt: ev?.endsAt,
    renewsAt: ev?.renewsAt,
    subscribeishTargets: ev?.subscribeishTargets,
  });
}

/**
 * Twitch Prime resub connector (reference implementation of a targeted, config-driven
 * action). Orchestration is unit-tested via an injected fake driver.
 */
export class TwitchConnector implements Connector, InteractiveLogin {
  readonly id = "twitch";
  readonly version = "0.2.0";
  readonly methods: ConnectionMethod[] = ["session_import", "credential_totp"];
  readonly loginUrl = "https://www.twitch.tv/login";
  // A Prime sub lasts until a known date; renewing it on a daily/weekly slot makes no sense.
  readonly schedulingMode = "on_expiry" as const;
  readonly configFields: ConfigField[] = [
    {
      key: "channel",
      // Explicitly the *streamer* being subscribed to, not the operator's own account — the
      // previous wording plus an example username read as "enter your account name".
      label: "Streamer channel to spend your Prime sub on",
      required: true,
      placeholder: "e.g. EmptyProfile",
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
    const driver = this.createDriver(session);
    let authenticated = false;
    try {
      if (input.method === "session_import") await driver.applyCookies(input.cookies);
      else {
        const totp = input.totpSeed ? ctx.totp(input.totpSeed) : undefined;
        await driver.loginWithPassword(input.email, input.password, totp);
      }

      if (!(await driver.isAuthenticated())) {
        return { outcome: "reauth_needed", summary: "Twitch session expired; reconnect the account." };
      }
      authenticated = true;

      let res = await driver.resubWithPrime(channel);
      if (res.captcha) {
        const token = await ctx.captcha.solve({
          type: "recaptcha_v2",
          websiteURL: TWITCH_RECAPTCHA_URL,
          websiteKey: TWITCH_RECAPTCHA_KEY,
        });
        if (token) res = await driver.resubWithPrime(channel);
      }
      // Logged once, on the attempt that counts, before any of the returns below.
      logVerdict(ctx.log, res);
      if (res.captcha) {
        ctx.emit({
          type: "requires_human_action",
          prompt: `A captcha must be solved to resubscribe to "${channel}". Solve it, then resume.`,
        });
        return { outcome: "requires_human_action", summary: `Captcha needed for "${channel}".` };
      }
      // The username comes from a cookie, so it's readable even when the channel was wrong —
      // report it so the dashboard still shows which account is connected.
      if (res.notFound) {
        return {
          outcome: "failed",
          summary: `Twitch channel "${channel}" was not found.`,
          accountFacts: { username: await driver.getUsername() },
        };
      }

      // The session is open, so report the account's name and the current Prime sub for free —
      // the dashboard shows them, and the sub's end date seeds the next automatic run. When the
      // API is what said the sub is active, its dates are the answer and there is nothing to ask
      // again; one that renews rather than ends is next due on its renewal date. After a resub
      // the verdict predates it, so the new end date has to be read afresh.
      const ev = res.evidence;
      const holdsSub = Boolean(res.alreadyActive || res.subscribed);
      const endsAt = !holdsSub
        ? undefined
        : res.alreadyActive && ev?.decidedBy === "api"
          ? (ev.endsAt ?? ev.renewsAt)
          : await driver.getPrimeSubEnd(channel);
      const accountFacts = {
        username: await driver.getUsername(),
        entitlements: holdsSub ? [{ kind: "prime_sub" as const, channel, endsAt }] : [],
      };

      if (res.alreadyActive) {
        return {
          outcome: "nothing_to_claim",
          summary: activeSubSummary(channel, ev),
          accountFacts,
        };
      }
      if (res.subscribed) {
        return {
          outcome: "claimed",
          summary: `Resubscribed to "${channel}" with Prime.`,
          claimedItems: [{ kind: "prime_sub" as const, title: channel }],
          accountFacts,
        };
      }
      // Reaching here means the resub did not happen and nothing explained it as a no-op. That
      // is a failure, not "nothing to do": the whole point of this connector is the renewal, and
      // reporting a skipped one as success is how it went unnoticed.
      return {
        outcome: "failed",
        summary: res.reason
          ? `Could not renew the Prime sub to "${channel}": ${res.reason}.`
          : `Could not renew the Prime sub to "${channel}".`,
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

  async isLoggedIn(session: SessionHandle, _ctx: ConnectorContext): Promise<boolean> {
    return this.createDriver(session).isAuthenticated();
  }

  async extractCookies(session: SessionHandle): Promise<BrowserCookie[]> {
    return this.createDriver(session).getCookies();
  }
}

export { PlaywrightTwitchDriver } from "./driver.js";
export type { TwitchPageDriver, TwitchDriverFactory } from "./driver.js";
