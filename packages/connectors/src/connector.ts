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

export interface ClaimResult {
  outcome: ClaimOutcome;
  /** Human-readable, secret-free summary. */
  summary: string;
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
