import type { CaptchaSolver, Logger } from "@uc/core";
import type { BrowserContext } from "playwright-core";

/** Connection methods a connector may support. */
export type ConnectionMethod = "session_import" | "credential_totp";

/** A browser cookie (Playwright-compatible shape). */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Persistent per-account browser identity (Constitution Principle VII). */
export interface Fingerprint {
  userAgent: string;
  timezoneId: string;
  locale: string;
  viewport: { width: number; height: number };
}

export type AuthInput =
  | { method: "session_import"; cookies: BrowserCookie[] }
  | { method: "credential_totp"; email: string; password: string; totpSeed?: string };

export interface AuthResult {
  ok: boolean;
  /** Fingerprint to persist and reuse for this account. */
  fingerprint: Fingerprint;
  /** Human-readable, secret-free reason (on failure). */
  reason?: string;
}

/** A per-account config field a connector needs (e.g. Twitch's target channel). */
export interface ConfigField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  /** Optional clarifying text rendered under the field (what the value is, and what it is not). */
  help?: string;
}

/** Per-account connector config values (non-secret, plain JSON). */
export type ConnectorConfig = Record<string, string>;

export type ClaimOutcome =
  | "claimed"
  | "nothing_to_claim"
  | "failed"
  | "reauth_needed"
  | "requires_human_action";

/** What a claim actually obtained — one entry per item, recorded for history and stats. */
export interface ClaimedItem {
  /** `game` for a store title, `prime_sub` for a Twitch Prime subscription, `points` for MS Rewards. */
  kind: "game" | "prime_sub" | "points";
  /** Display title (game name, channel name, …). Never a secret. */
  title: string;
}

/**
 * A currently-active benefit on the account worth surfacing in the dashboard — notably a Twitch
 * Prime subscription, whose end date is a natural default for the next automatic run.
 */
export interface Entitlement {
  kind: "prime_sub";
  /** Channel the subscription applies to. */
  channel?: string;
  /** When it expires/renews, ISO 8601. */
  endsAt?: string;
}

/**
 * Non-secret facts about a connected account, reported opportunistically by a connector during a
 * run (the session is already open, so this costs nothing extra).
 */
export interface AccountFacts {
  /** The account's own username on the service (e.g. the Twitch/Epic display name). */
  username?: string;
  entitlements?: Entitlement[];
}

export interface ClaimResult {
  outcome: ClaimOutcome;
  /** Human-readable, secret-free summary. */
  summary: string;
  /** Structured record of what was obtained, for the claim history and stats. */
  claimedItems?: ClaimedItem[];
  /** Account facts observed during this run (username, active entitlements). */
  accountFacts?: AccountFacts;
}

export interface HealthResult {
  healthy: boolean;
  detail?: string;
}

/** Events a connector emits during a run (relayed to the dashboard / webhook). */
export type JobEvent =
  | { type: "progress"; message: string }
  | { type: "requires_human_action"; prompt: string; screenshot?: Buffer };

/** An authenticated browser context handed to `claim`. */
export interface SessionHandle {
  context: BrowserContext;
}

/** Launches an anti-detect browser (CloakBrowser, headed via Xvfb) with a fingerprint. */
export interface BrowserFactory {
  launch(fingerprint: Fingerprint): Promise<SessionHandle>;
  close(session: SessionHandle): Promise<void>;
}

/** Provided by the worker runtime to each connector call. */
export interface ConnectorContext {
  browser: BrowserFactory;
  captcha: CaptchaSolver;
  totp(seed: string): string;
  emit(event: JobEvent): void;
  log: Logger;
}

/**
 * The connector-agnostic contract every service plugin implements (Constitution
 * Principle I). The app and worker depend only on this interface — never on a concrete
 * connector. See contracts/connector-interface.md for the full behavioral contract.
 */
export interface Connector {
  readonly id: string;
  readonly version: string;
  readonly methods: ConnectionMethod[];
  /** Per-account config fields the connect flow must collect (e.g. Twitch channel). */
  readonly configFields?: ConfigField[];
  /**
   * How this service is naturally scheduled. `recurring` (the default) suits things that come
   * back on a clock — Epic's weekly free games, daily Rewards points. `on_expiry` suits a benefit
   * that lasts until a known date and is renewed when it runs out (a Twitch Prime sub): a
   * daily/weekly slot would be meaningless there.
   */
  readonly schedulingMode?: "recurring" | "on_expiry";

  /** Validate/normalize a provided secret and return the fingerprint to persist. */
  authenticate(input: AuthInput, ctx: ConnectorContext): Promise<AuthResult>;

  /**
   * Perform one claim. The connector launches its own browser session with the account's
   * persisted fingerprint, re-establishes authentication from the secret, performs the
   * action (using per-account `config`), and closes the session. Returns `reauth_needed` if
   * the stored secret no longer authenticates.
   */
  claim(
    input: AuthInput,
    fingerprint: Fingerprint,
    config: ConnectorConfig,
    ctx: ConnectorContext,
  ): Promise<ClaimResult>;

  /** Lightweight liveness/UI-shape check feeding the connector health monitor. */
  healthCheck(ctx: ConnectorContext): Promise<HealthResult>;
}

/**
 * Optional capability: a connector that supports assisted login — the operator logs in
 * inside an instance-controlled browser and the session cookies are captured automatically
 * (see docs/design/assisted-login.md).
 */
export interface InteractiveLogin {
  /** URL where the operator logs in. */
  readonly loginUrl: string;
  /** True once the operator has completed login in the given session. */
  isLoggedIn(session: SessionHandle, ctx: ConnectorContext): Promise<boolean>;
  /** Read the session cookies to persist after a successful login. */
  extractCookies(session: SessionHandle): Promise<BrowserCookie[]>;
}

/** Type guard for connectors that support assisted login. */
export function supportsInteractiveLogin(
  connector: Connector,
): connector is Connector & InteractiveLogin {
  return typeof (connector as Partial<InteractiveLogin>).loginUrl === "string";
}
