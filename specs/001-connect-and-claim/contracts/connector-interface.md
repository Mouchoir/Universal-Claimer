# Contract: Connector Interface

The connector-agnostic contract every service plugin implements (Constitution Principle I).
The app and worker depend only on this interface — never on a concrete connector. Adding a
new service (Microsoft Rewards, Twitch) means adding a package that implements this, with no
change to the app, worker, queue, or data model.

## TypeScript interface (authoritative shape)

```ts
export interface Connector {
  /** Stable service id, matches service.id in the DB (e.g. "epic"). */
  readonly id: string;
  /** Connector plugin version, surfaced in health reports. */
  readonly version: string;
  /** Connection methods this connector supports. */
  readonly methods: ConnectionMethod[];

  /**
   * Validate/normalize a secret the operator provided at connect time.
   * MUST NOT perform the claim. For session_import, may probe that the session
   * is currently authenticated. Returns the fingerprint to persist.
   * MUST NOT log or return the secret.
   */
  authenticate(input: AuthInput, ctx: ConnectorContext): Promise<AuthResult>;

  /**
   * Perform one claim. The connector launches its own browser session with the account's
   * persisted fingerprint, re-establishes auth from the secret, claims, and closes the
   * session. Reports progress/human-action via ctx.emit. Returns a terminal outcome.
   */
  claim(input: AuthInput, fingerprint: Fingerprint, ctx: ConnectorContext): Promise<ClaimResult>;

  /** Lightweight liveness/UI-shape check; feeds the connector health monitor. */
  healthCheck(ctx: ConnectorContext): Promise<HealthResult>;
}

export type ConnectionMethod = "session_import" | "credential_totp";

export type AuthInput =
  | { method: "session_import"; cookies: BrowserCookie[] }
  | { method: "credential_totp"; email: string; password: string; totpSeed?: string };

export interface AuthResult {
  ok: boolean;
  fingerprint: Fingerprint;      // UA/timezone/locale/viewport to persist and reuse
  reason?: string;               // human-readable, secret-free
}

export interface ClaimResult {
  outcome: "claimed" | "nothing_to_claim" | "failed" | "reauth_needed";
  summary: string;               // human-readable, MUST be secret-free
}

export interface HealthResult {
  healthy: boolean;
  detail?: string;
}

/** Provided by the worker runtime to each call. */
export interface ConnectorContext {
  /** Launches CloakBrowser (headed via Xvfb) with the account fingerprint applied. */
  browser: BrowserFactory;
  /** Auto-solve a detected captcha; resolves null if unavailable/unconfigured. */
  captcha: CaptchaSolver;
  /** Generate a TOTP code from a seed (credential_totp path). */
  totp(seed: string): string;
  /** Emit a job event (progress, requires_human_action, ...). */
  emit(event: JobEvent): void;
  /** Structured logger with secret redaction enforced. */
  log: RedactingLogger;
}
```

## Behavioral contract (all connectors MUST honor)

1. **No secrets out**: never write secrets to logs, `summary`, `reason`, screenshots, or
   thrown errors. The provided logger redacts known secret fields; connectors must not
   bypass it.
2. **Consent is enforced upstream**: the worker refuses to dispatch `claim` without a
   consent record; connectors may assume consent exists but must not themselves accept TOS.
3. **Captcha layering**: on a detected challenge, call `ctx.captcha.solve(...)` first; if it
   returns null or fails, `ctx.emit({type: "requires_human_action", ...})` and await
   resolution — never open a VNC/remote desktop.
4. **Expired session**: if the session is no longer authenticated, return
   `outcome: "reauth_needed"` (do not loop retrying).
5. **Idempotent-ish claim**: re-running when nothing is available returns
   `nothing_to_claim`, not `failed`.
6. **Determinism for tests**: all platform interactions go through `ctx.browser`, so contract
   tests can drive the connector against recorded fixtures with no live network.

## Contract test expectations (per connector)

- `authenticate` accepts a valid fixture session/credentials → `ok: true` + fingerprint.
- `authenticate` with an expired fixture session → `ok: false` (or `claim` later returns
  `reauth_needed`).
- `claim` against a "free item available" fixture → `claimed`.
- `claim` against a "nothing available" fixture → `nothing_to_claim`.
- `claim` against a "captcha" fixture with a stub solver → attempts solve, then emits
  `requires_human_action` when the stub fails.
- No fixture run leaks a secret into any output (asserted by a redaction check).
