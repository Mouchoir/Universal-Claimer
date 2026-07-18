# @uc/connectors

The connector-agnostic runtime and per-service plugins (Constitution Principle I).

## What's here

- **connector.ts** — the `Connector` interface plus the runtime types (`ConnectorContext`,
  `BrowserFactory`, `SessionHandle`, `AuthInput`, `ClaimResult`, `JobEvent`, `Fingerprint`).
  The app and worker depend only on these — never on a concrete connector.
- **registry.ts** — `ConnectorRegistry`, resolve connectors by service id.
- **browser.ts** — `CloakBrowserFactory`: launches CloakBrowser via playwright-core with a
  per-account fingerprint (headed via Xvfb on a headless host; x86_64 required).
- **cookies.ts** — `parseCookiesTxt` (Netscape format) / `parseCookiesJson` for the guided
  session-import flow.
- **totp.ts** — `generateTotp` / `verifyTotp` (otplib) for the credential+TOTP login path.

## Adding a connector

Create `src/<service>/` implementing `Connector` and register it. No change to the app,
worker, queue, or data model is allowed (Principle I). Ship it with a contract test against
recorded fixtures under `tests/fixtures/<service>/` (see contracts/connector-interface.md).

## Test

```bash
corepack pnpm --filter @uc/connectors exec vitest run   # or: corepack pnpm test
```
